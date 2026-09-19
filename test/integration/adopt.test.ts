// BAKR-24 Q3/Q5/Q6/Q7: the impure adopt orchestrator, exercised against REAL
// files and REAL directories — not just adopt-model.ts's pure functions —
// per the ticket's own "refusals demonstrated live, not only in unit tests"
// standard (DoD #6). No real `claude`/`systemd-run` here (that is the
// separate live-e2e demonstration written up in the doc); this file proves
// adopt.ts's own store wiring, locking, and ordering are correct against a
// real filesystem.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";
import { adopt, type AdoptDeps } from "../../src/adopt";
import { claim, emptyStore, lookup as lookupClaim } from "../../src/claim-model";
import { save as saveClaims, load as loadClaims } from "../../src/claim-store-io";
import { emptyAgentStore, putAgent, beginLaunch, markLaunchFailed, hasLaunchRecordFor, restoreAttemptCount, recordRestoreAttempt, type AgentRecord } from "../../src/agent-model";
import { save as saveAgents, load as loadAgents } from "../../src/agent-store-io";
import { realResolveInputs, realOrphanProbeDeps } from "../../src/paths";
import type { ClaimKey } from "../../src/claim-key-resolve";
import { snapshotTree, diffTreeSnapshots } from "./fixtures/tree-snapshot";

const cleanupDirs: string[] = [];

afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(prefix = "bakr-adopt-test-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

function makeAgent(overrides: Partial<AgentRecord> & { id: string; directory: ClaimKey }): AgentRecord {
  return { name: undefined, state: "on", createdAt: 1, birthSessionId: undefined, restoreTarget: undefined, ...overrides };
}

function makeDeps(storeDir: string): AdoptDeps {
  return {
    claimsPath: join(storeDir, "claims.json"),
    agentsPath: join(storeDir, "agents.json"),
    now: () => 1_700_000_000_000,
    resolveInputs: realResolveInputs,
    lexicalInputs: { cwd: process.cwd(), home: homedir() },
    probeDeps: realOrphanProbeDeps,
  };
}

/** Creates a real directory, claims it, then DELETES it — a genuine orphan an adopt can act on. Returns its ClaimKey (captured before deletion, so still a valid absolute path string). */
async function makeOrphan(storeDir: string): Promise<ClaimKey> {
  const parent = await makeTempDir("bakr-adopt-orphan-parent-");
  const dir = join(parent, "moved-away") as ClaimKey;
  await mkdir(dir);
  let claimState = (await loadClaims(join(storeDir, "claims.json"))).status === "loaded" ? (await loadClaims(join(storeDir, "claims.json"))) : undefined;
  const current = claimState && claimState.status === "loaded" ? claimState.state : emptyStore();
  const next = claim(current, dir, 1000).state;
  await saveClaims(join(storeDir, "claims.json"), next);
  await rm(dir, { recursive: true, force: true });
  return dir;
}

describe("adopt: the successful path (Q3/Q6/Q7)", () => {
  test("moves the named agent, claims a previously-unclaimed destination, resets retry counts, discards launch records and reports them (B13)", async () => {
    const storeDir = await makeTempDir();
    const source = await makeOrphan(storeDir);
    const destination = await makeTempDir("bakr-adopt-dest-");

    let agentState = putAgent(emptyAgentStore(), makeAgent({ id: "@a1", directory: source, name: "worker-one", birthSessionId: "durable-x", restoreTarget: { sessionId: "durable-x", shortId: "durable-x" } }));
    agentState = recordRestoreAttempt(agentState, "@a1");
    agentState = beginLaunch(agentState, "@a1", source, { kind: "respawn", shortId: "durable-x" }, "given-up-attempt", 100);
    agentState = markLaunchFailed(agentState, "given-up-attempt", "gave up after 3 consecutive restore attempts — unrelated to the move");
    await saveAgents(join(storeDir, "agents.json"), agentState);

    // Destination is NOT yet claimed.
    const claimsBefore = await loadClaims(join(storeDir, "claims.json"));
    expect(claimsBefore.status).toBe("loaded");
    if (claimsBefore.status === "loaded") expect(lookupClaim(claimsBefore.state, destination as unknown as ClaimKey)).toBeUndefined();

    const outcome = await adopt(makeDeps(storeDir), { source, destinationInput: destination, agentIds: ["@a1"] });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.adoptedAgentIds).toEqual(["@a1"]);
    expect(outcome.clearedLaunchRecords).toEqual([{ agentId: "@a1", attemptId: "given-up-attempt", error: expect.stringContaining("gave up after 3 consecutive restore attempts") }]);

    // Q6: destination is now claimed.
    const claimsAfter = await loadClaims(join(storeDir, "claims.json"));
    expect(claimsAfter.status).toBe("loaded");
    if (claimsAfter.status === "loaded") expect(lookupClaim(claimsAfter.state, outcome.destination)).toBeDefined();

    // Agent moved, retry count reset, launch record discarded (eligible to restore in its new home).
    const agentsAfter = await loadAgents(join(storeDir, "agents.json"));
    expect(agentsAfter.status).toBe("loaded");
    if (agentsAfter.status === "loaded") {
      const moved = agentsAfter.state.agents["@a1"];
      expect(moved?.directory).toBe(outcome.destination);
      expect(restoreAttemptCount(agentsAfter.state, "@a1")).toBe(0);
      expect(hasLaunchRecordFor(agentsAfter.state, "@a1", { kind: "respawn", shortId: "durable-x" })).toBe(false);
    }

    // Q7: the OLD claim is NOT auto-released, even though its last agent just left.
    if (claimsAfter.status === "loaded") {
      expect(lookupClaim(claimsAfter.state, source)).toBeDefined();
    }
  });

  test("Q6 ordering: adopting into an ALREADY-claimed destination is idempotent (claim() returns the existing claim unchanged)", async () => {
    const storeDir = await makeTempDir();
    const source = await makeOrphan(storeDir);
    const destination = await makeTempDir("bakr-adopt-dest-");

    // Pre-claim the destination with an old timestamp.
    const preClaimed = claim(emptyStore(), destination as unknown as ClaimKey, 1).state;
    // merge with the source claim already on disk from makeOrphan
    const existing = await loadClaims(join(storeDir, "claims.json"));
    const merged = existing.status === "loaded" ? { claims: { ...existing.state.claims, ...preClaimed.claims } } : preClaimed;
    await saveClaims(join(storeDir, "claims.json"), merged);

    const agentState = putAgent(emptyAgentStore(), makeAgent({ id: "@a1", directory: source }));
    await saveAgents(join(storeDir, "agents.json"), agentState);

    const outcome = await adopt(makeDeps(storeDir), { source, destinationInput: destination, agentIds: ["@a1"] });
    expect(outcome.ok).toBe(true);

    const claimsAfter = await loadClaims(join(storeDir, "claims.json"));
    expect(claimsAfter.status).toBe("loaded");
    if (claimsAfter.status === "loaded") {
      const destClaim = lookupClaim(claimsAfter.state, destination as unknown as ClaimKey);
      expect(destClaim?.claimedAt).toBe(1); // UNCHANGED — never re-stamped
    }
  });
});

describe("adopt: refusals, live (DoD #6)", () => {
  test("empty-selection", async () => {
    const storeDir = await makeTempDir();
    const source = await makeOrphan(storeDir);
    const destination = await makeTempDir("bakr-adopt-dest-");
    await saveAgents(join(storeDir, "agents.json"), emptyAgentStore());
    const outcome = await adopt(makeDeps(storeDir), { source, destinationInput: destination, agentIds: [] });
    expect(outcome).toEqual({ ok: false, reason: "empty-selection", message: expect.any(String) });
  });

  test("destination-missing: bakr never creates the destination", async () => {
    const storeDir = await makeTempDir();
    const source = await makeOrphan(storeDir);
    const agentState = putAgent(emptyAgentStore(), makeAgent({ id: "@a1", directory: source }));
    await saveAgents(join(storeDir, "agents.json"), agentState);

    const outcome = await adopt(makeDeps(storeDir), { source, destinationInput: join(storeDir, "does-not-exist"), agentIds: ["@a1"] });
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.reason).toBe("destination-missing");
  });

  test("destination-not-a-directory: destination resolves to a regular FILE", async () => {
    const storeDir = await makeTempDir();
    const source = await makeOrphan(storeDir);
    const agentState = putAgent(emptyAgentStore(), makeAgent({ id: "@a1", directory: source }));
    await saveAgents(join(storeDir, "agents.json"), agentState);
    const filePath = join(storeDir, "im-a-file");
    await writeFile(filePath, "not a directory", "utf8");

    const outcome = await adopt(makeDeps(storeDir), { source, destinationInput: filePath, agentIds: ["@a1"] });
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.reason).toBe("destination-not-a-directory");
  });

  test("destination-is-source", async () => {
    const storeDir = await makeTempDir();
    const source = await makeOrphan(storeDir);
    const agentState = putAgent(emptyAgentStore(), makeAgent({ id: "@a1", directory: source }));
    await saveAgents(join(storeDir, "agents.json"), agentState);

    // destination-is-source can only be reached with a destination that RESOLVES — so use the source's own (still-existing) parent trick is wrong since source itself is gone; instead prove the check with a present directory that IS the source at adopt time is impossible (source is gone) — so this refusal is naturally reached when destinationInput resolves to the SAME key as source, which requires source to still exist. Use a present directory as both source and destination to isolate this one check via direct validation instead.
    const { validateAdopt } = await import("../../src/adopt-model");
    const dir = await makeTempDir("bakr-adopt-same-");
    const key = dir as unknown as ClaimKey;
    const result = validateAdopt({ agentState, source: key, destination: key, agentIds: ["@a1"], sourceVerdictStatus: "gone" });
    expect(result).toEqual({ ok: false, reason: "destination-is-source", message: expect.any(String) });
  });

  test("source-not-orphaned: source directory still resolves", async () => {
    const storeDir = await makeTempDir();
    const source = (await makeTempDir("bakr-adopt-still-present-")) as unknown as ClaimKey; // NOT deleted
    await saveClaims(join(storeDir, "claims.json"), claim(emptyStore(), source, 1).state);
    const destination = await makeTempDir("bakr-adopt-dest-");
    const agentState = putAgent(emptyAgentStore(), makeAgent({ id: "@a1", directory: source }));
    await saveAgents(join(storeDir, "agents.json"), agentState);

    const outcome = await adopt(makeDeps(storeDir), { source, destinationInput: destination, agentIds: ["@a1"] });
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.reason).toBe("source-not-orphaned");
  });

  test("unknown-agent", async () => {
    const storeDir = await makeTempDir();
    const source = await makeOrphan(storeDir);
    const destination = await makeTempDir("bakr-adopt-dest-");
    await saveAgents(join(storeDir, "agents.json"), emptyAgentStore());

    const outcome = await adopt(makeDeps(storeDir), { source, destinationInput: destination, agentIds: ["@ghost"] });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok && outcome.reason === "unknown-agent") {
      expect(outcome.agentIds).toEqual(["@ghost"]);
    } else {
      throw new Error(`expected unknown-agent, got ${JSON.stringify(outcome)}`);
    }
  });

  test("agent-not-in-source", async () => {
    const storeDir = await makeTempDir();
    const source = await makeOrphan(storeDir);
    const elsewhere = (await makeTempDir("bakr-adopt-elsewhere-")) as unknown as ClaimKey;
    const destination = await makeTempDir("bakr-adopt-dest-");
    const agentState = putAgent(emptyAgentStore(), makeAgent({ id: "@a1", directory: elsewhere }));
    await saveAgents(join(storeDir, "agents.json"), agentState);

    const outcome = await adopt(makeDeps(storeDir), { source, destinationInput: destination, agentIds: ["@a1"] });
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.reason).toBe("agent-not-in-source");
  });

  // BAKR-34/BAKR-42 R9: custom names — and the name-collision check that
  // used to run here — are retired. Adopting into a directory that already
  // holds a non-archived agent now simply succeeds (see adopt-model.ts's
  // own module comment): R6's one-per-directory line is drawn at `create`,
  // not at adopt.
  test("adopting into a destination that already holds a DIFFERENT agent succeeds — no name-collision check exists any more", async () => {
    const storeDir = await makeTempDir();
    const source = await makeOrphan(storeDir);
    const destination = await makeTempDir("bakr-adopt-dest-");
    let agentState = putAgent(emptyAgentStore(), makeAgent({ id: "@a1", directory: source, name: "worker" }));
    agentState = putAgent(agentState, makeAgent({ id: "@holder", directory: destination as unknown as ClaimKey, name: "worker" }));
    await saveAgents(join(storeDir, "agents.json"), agentState);

    const outcome = await adopt(makeDeps(storeDir), { source, destinationInput: destination, agentIds: ["@a1"] });
    expect(outcome.ok).toBe(true);
  });

  test("SECOND ADOPTER: two candidates racing for the same orphan — the first succeeds, the second gets a typed refusal naming where the agents went (Q3)", async () => {
    const storeDir = await makeTempDir();
    const source = await makeOrphan(storeDir);
    const destinationA = await makeTempDir("bakr-adopt-dest-a-");
    const destinationB = await makeTempDir("bakr-adopt-dest-b-");
    const agentState = putAgent(emptyAgentStore(), makeAgent({ id: "@a1", directory: source }));
    await saveAgents(join(storeDir, "agents.json"), agentState);

    const first = await adopt(makeDeps(storeDir), { source, destinationInput: destinationA, agentIds: ["@a1"] });
    expect(first.ok).toBe(true);

    const second = await adopt(makeDeps(storeDir), { source, destinationInput: destinationB, agentIds: ["@a1"] });
    expect(second.ok).toBe(false);
    if (!second.ok && second.reason === "agent-not-in-source") {
      expect(second.agents[0]?.id).toBe("@a1");
      expect(second.agents[0]?.currentDirectory).toContain("bakr-adopt-dest-a-"); // names WHERE it went
    } else {
      throw new Error(`expected agent-not-in-source, got ${JSON.stringify(second)}`);
    }

    // destinationB was still claimed as a SIDE EFFECT of the attempt (Q6: claiming is harmless even on a later-refused adopt) — but @a1 never moved there.
    const claimsAfter = await loadClaims(join(storeDir, "claims.json"));
    expect(claimsAfter.status).toBe("loaded");
  });
});

describe("adopt: nothing is written into either directory (DoD #7, [CORRECTED])", () => {
  test("a CONTENT-SENSITIVE recursive snapshot of the destination (with a nested file) and of the source's surviving PARENT is byte-identical before and after adopt() — not just mtime-identical (see tree-snapshot.test.ts for proof this instrument catches what an mtime-only probe would miss)", async () => {
    const storeDir = await makeTempDir();
    const parent = await makeTempDir("bakr-adopt-orphan-parent-"); // survives — the source itself is deleted, but its parent must stay untouched too
    await writeFile(join(parent, "sibling.txt"), "a sibling directory entry that must never be touched", "utf8");
    const sourceDir = join(parent, "moved-away") as ClaimKey;
    await mkdir(sourceDir);
    await saveClaims(join(storeDir, "claims.json"), claim(emptyStore(), sourceDir, 1).state);
    await rm(sourceDir, { recursive: true, force: true }); // orphan it

    const destination = await makeTempDir("bakr-adopt-dest-");
    await writeFile(join(destination, "existing-file.txt"), "untouched top-level content", "utf8");
    await mkdir(join(destination, "nested"));
    await writeFile(join(destination, "nested", "inner.txt"), "untouched nested content", "utf8");

    const beforeDest = await snapshotTree(destination);
    const beforeParent = await snapshotTree(parent);

    const agentState = putAgent(emptyAgentStore(), makeAgent({ id: "@a1", directory: sourceDir }));
    await saveAgents(join(storeDir, "agents.json"), agentState);

    const outcome = await adopt(makeDeps(storeDir), { source: sourceDir, destinationInput: destination, agentIds: ["@a1"] });
    expect(outcome.ok).toBe(true);

    const afterDest = await snapshotTree(destination);
    const afterParent = await snapshotTree(parent);

    const destDiff = diffTreeSnapshots(beforeDest, afterDest);
    const parentDiff = diffTreeSnapshots(beforeParent, afterParent);
    expect(destDiff).toEqual({ changed: false, details: [] });
    expect(parentDiff).toEqual({ changed: false, details: [] });
  });
});
