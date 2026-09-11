import { describe, expect, test } from "bun:test";
import { classifyDirectory, classifyClaims, buildOffers, buildUnavailableReports, applyDestinationHint } from "../../src/orphan-model";
import type { DirectoryProbe } from "../../src/orphan-probe";
import { claim, emptyStore } from "../../src/claim-model";
import { emptyAgentStore, putAgent, type AgentRecord } from "../../src/agent-model";
import type { ClaimKey } from "../../src/claim-key-resolve";

const KEY = "/old/path" as ClaimKey;

function makeAgent(overrides: Partial<AgentRecord> & { id: string; directory: ClaimKey }): AgentRecord {
  return { name: undefined, state: "on", createdAt: 1, durableSessionId: undefined, liveSessionId: undefined, ...overrides };
}

describe("classifyDirectory (Q1)", () => {
  test("exists -> present", () => {
    const probe: DirectoryProbe = { kind: "exists", device: 1, inode: 1, isDirectory: true };
    expect(classifyDirectory(probe, undefined)).toEqual({ status: "present" });
  });

  test("a stat error (EACCES/EIO/ENOTCONN-shaped, never ENOENT) -> unavailable, never gone", () => {
    const probe: DirectoryProbe = { kind: "stat-error", message: "EACCES: permission denied" };
    const verdict = classifyDirectory(probe, undefined);
    expect(verdict.status).toBe("unavailable");
  });

  test("ENOENT with no ancestor found at all -> unavailable (cannot even confirm truly gone)", () => {
    const probe: DirectoryProbe = { kind: "enoent", ancestor: undefined };
    expect(classifyDirectory(probe, undefined).status).toBe("unavailable");
  });

  test("ENOENT with an unreadable ancestor -> unavailable", () => {
    const probe: DirectoryProbe = { kind: "enoent", ancestor: { path: "/old", readable: false, device: undefined } };
    expect(classifyDirectory(probe, 42).status).toBe("unavailable");
  });

  test("ENOENT, readable ancestor, SAME recorded device -> gone, high confidence", () => {
    const probe: DirectoryProbe = { kind: "enoent", ancestor: { path: "/old", readable: true, device: 42 } };
    const verdict = classifyDirectory(probe, 42);
    expect(verdict).toEqual({ status: "gone", confidence: "high", reason: expect.any(String) });
  });

  test("ENOENT, readable ancestor, DIFFERENT device than recorded -> unavailable (likely an unmounted filesystem), NOT gone", () => {
    const probe: DirectoryProbe = { kind: "enoent", ancestor: { path: "/old", readable: true, device: 99 } };
    const verdict = classifyDirectory(probe, 42);
    expect(verdict.status).toBe("unavailable");
  });

  test("ENOENT, readable ancestor, NO recorded device at all (an old claim) -> gone, REDUCED confidence — offered, not hidden", () => {
    const probe: DirectoryProbe = { kind: "enoent", ancestor: { path: "/old", readable: true, device: 42 } };
    const verdict = classifyDirectory(probe, undefined);
    expect(verdict).toEqual({ status: "gone", confidence: "reduced", reason: expect.any(String) });
  });
});

describe("classifyClaims / buildOffers / buildUnavailableReports (Q1: only gone produces an offer)", () => {
  test("a present claim produces neither an offer nor an unavailable report", () => {
    const { state: claimState } = claim(emptyStore(), KEY, 1000);
    const probes = new Map<ClaimKey, DirectoryProbe>([[KEY, { kind: "exists", device: 1, inode: 1, isDirectory: true }]]);
    const classifications = classifyClaims(claimState, emptyAgentStore(), probes);
    expect(buildOffers(classifications)).toEqual([]);
    expect(buildUnavailableReports(classifications)).toEqual([]);
  });

  test("a gone claim produces exactly one offer carrying its agents (id, name, state)", () => {
    const { state: claimState } = claim(emptyStore(), KEY, 1000);
    let agentState = emptyAgentStore();
    agentState = putAgent(agentState, makeAgent({ id: "@a1", directory: KEY, name: "worker-one", state: "on" }));
    agentState = putAgent(agentState, makeAgent({ id: "@a2", directory: KEY, state: "off" }));
    const probes = new Map<ClaimKey, DirectoryProbe>([[KEY, { kind: "enoent", ancestor: { path: "/old", readable: true, device: 1 } }]]);

    const classifications = classifyClaims(claimState, agentState, probes);
    const offers = buildOffers(classifications);
    expect(offers).toHaveLength(1);
    expect(offers[0]?.source).toBe(KEY);
    expect(offers[0]?.confidence).toBe("reduced"); // no dirIdentity was recorded on this claim
    expect(new Set(offers[0]?.agents.map((a) => a.id))).toEqual(new Set(["@a1", "@a2"]));
    expect(offers[0]?.agents.find((a) => a.id === "@a1")).toEqual({ id: "@a1", name: "worker-one", state: "on" });
    expect(buildUnavailableReports(classifications)).toEqual([]);
  });

  test("an unavailable claim produces a report and NOTHING ELSE — never an offer", () => {
    const { state: claimState } = claim(emptyStore(), KEY, 1000);
    const agentState = putAgent(emptyAgentStore(), makeAgent({ id: "@a1", directory: KEY }));
    const probes = new Map<ClaimKey, DirectoryProbe>([[KEY, { kind: "stat-error", message: "EIO" }]]);

    const classifications = classifyClaims(claimState, agentState, probes);
    expect(buildOffers(classifications)).toEqual([]);
    const reports = buildUnavailableReports(classifications);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.source).toBe(KEY);
  });

  test("no probe result supplied for a claim -> classified unavailable, never guessed as gone", () => {
    const { state: claimState } = claim(emptyStore(), KEY, 1000);
    const classifications = classifyClaims(claimState, emptyAgentStore(), new Map());
    expect(classifications[0]?.verdict.status).toBe("unavailable");
  });

  test("DETECTION NEVER MUTATES: running classification+offer-building against real stores leaves both byte-identical on disk", async () => {
    const { mkdtemp, rm, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { save: saveClaims } = await import("../../src/claim-store-io");
    const { save: saveAgents } = await import("../../src/agent-store-io");

    const dir = await mkdtemp(join(tmpdir(), "bakr-orphan-no-mutate-"));
    try {
      const claimsPath = join(dir, "claims.json");
      const agentsPath = join(dir, "agents.json");
      const { state: claimState } = claim(emptyStore(), KEY, 1000);
      const agentState = putAgent(emptyAgentStore(), makeAgent({ id: "@a1", directory: KEY }));
      await saveClaims(claimsPath, claimState);
      await saveAgents(agentsPath, agentState);

      const beforeClaims = await readFile(claimsPath, "utf8");
      const beforeAgents = await readFile(agentsPath, "utf8");

      // Run the whole read side: classify + build offers + build reports + apply a hint.
      const probes = new Map<ClaimKey, DirectoryProbe>([[KEY, { kind: "enoent", ancestor: { path: "/old", readable: true, device: 1 } }]]);
      const classifications = classifyClaims(claimState, agentState, probes);
      const offers = buildOffers(classifications);
      buildUnavailableReports(classifications);
      applyDestinationHint(offers, { dev: 1, ino: 2 }, "/new/path" as ClaimKey);

      const afterClaims = await readFile(claimsPath, "utf8");
      const afterAgents = await readFile(agentsPath, "utf8");
      expect(afterClaims).toBe(beforeClaims);
      expect(afterAgents).toBe(beforeAgents);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("applyDestinationHint (Q2: ranks, never decides)", () => {
  test("a matching {dev,ino} marks the offer hint-matched", () => {
    const { state: claimState } = claim(emptyStore(), KEY, 1000, { dev: 7, ino: 99 });
    const agentState = putAgent(emptyAgentStore(), makeAgent({ id: "@a1", directory: KEY }));
    const probes = new Map<ClaimKey, DirectoryProbe>([[KEY, { kind: "enoent", ancestor: { path: "/old", readable: true, device: 7 } }]]);
    const offers = buildOffers(classifyClaims(claimState, agentState, probes));

    const destination = "/new/path" as ClaimKey;
    const hinted = applyDestinationHint(offers, { dev: 7, ino: 99 }, destination);
    expect(hinted[0]?.hintMatchedDestination).toBe(destination);
  });

  test("a NON-matching {dev,ino} leaves the offer unmatched — same-fs-move survives, cross-fs/coincidence does not decide anything", () => {
    const { state: claimState } = claim(emptyStore(), KEY, 1000, { dev: 7, ino: 99 });
    const agentState = putAgent(emptyAgentStore(), makeAgent({ id: "@a1", directory: KEY }));
    const probes = new Map<ClaimKey, DirectoryProbe>([[KEY, { kind: "enoent", ancestor: { path: "/old", readable: true, device: 7 } }]]);
    const offers = buildOffers(classifyClaims(claimState, agentState, probes));

    const hinted = applyDestinationHint(offers, { dev: 7, ino: 12345 }, "/new/path" as ClaimKey);
    expect(hinted[0]?.hintMatchedDestination).toBeUndefined();
  });

  test("an orphan with NO recorded identity at all is still offered, just never hint-matched — reduced confidence, not reduced explicitness", () => {
    const { state: claimState } = claim(emptyStore(), KEY, 1000); // no dirIdentity
    const agentState = putAgent(emptyAgentStore(), makeAgent({ id: "@a1", directory: KEY }));
    const probes = new Map<ClaimKey, DirectoryProbe>([[KEY, { kind: "enoent", ancestor: { path: "/old", readable: true, device: 7 } }]]);
    const offers = buildOffers(classifyClaims(claimState, agentState, probes));
    expect(offers).toHaveLength(1);
    expect(offers[0]?.confidence).toBe("reduced");

    const hinted = applyDestinationHint(offers, { dev: 7, ino: 99 }, "/new/path" as ClaimKey);
    expect(hinted[0]?.hintMatchedDestination).toBeUndefined(); // nothing to match against
    expect(hinted).toHaveLength(1); // still offered
  });

  test("a hint match never shrinks the offer's own agent list, and every offer survives whether matched or not — ranking, not selecting", () => {
    const KEY_B = "/old/path/b" as ClaimKey;
    const { state: s1 } = claim(emptyStore(), KEY, 1000, { dev: 7, ino: 99 });
    const { state: claimState } = claim(s1, KEY_B, 2000, { dev: 7, ino: 555 });
    let agentState = putAgent(emptyAgentStore(), makeAgent({ id: "@a1", directory: KEY }));
    agentState = putAgent(agentState, makeAgent({ id: "@b1", directory: KEY_B }));
    const probes = new Map<ClaimKey, DirectoryProbe>([
      [KEY, { kind: "enoent", ancestor: { path: "/old", readable: true, device: 7 } }],
      [KEY_B, { kind: "enoent", ancestor: { path: "/old", readable: true, device: 7 } }],
    ]);
    const offers = buildOffers(classifyClaims(claimState, agentState, probes));
    expect(offers).toHaveLength(2);

    const newPath = "/new/path" as ClaimKey;
    const hinted = applyDestinationHint(offers, { dev: 7, ino: 99 }, newPath);
    expect(hinted).toHaveLength(2); // BOTH still present
    expect(hinted.find((o) => o.source === KEY)?.hintMatchedDestination).toBe(newPath);
    expect(hinted.find((o) => o.source === KEY_B)?.hintMatchedDestination).toBeUndefined();
    expect(hinted.find((o) => o.source === KEY_B)?.agents).toHaveLength(1); // unaffected agent list, not filtered out
  });
});
