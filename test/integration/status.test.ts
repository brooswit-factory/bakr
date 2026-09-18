// BAKR-48, end to end: `bakr status [--json]` driven through the REAL CLI
// (`runCli`) against the fake host and a real agents.json on disk. The pure
// verdicts are pinned per-code in test/unit/status-model.test.ts; what this
// file proves is the part only a real run can prove:
//
//   1. the consumer's hard requirement 1 — STRICTLY READ-ONLY: no herdr
//      command other than `agent list` / `agent read`, no `claude` command at
//      all, and the store file's bytes unchanged, byte for byte;
//   2. the exit codes, with the JSON printed in every case, including both
//      "couldn't check" cases;
//   3. requirement 5 — under ~2s for 11 agents;
//   4. that it is valid from any cwd: the deps below make every
//      directory-resolution, claim, probe and messenger path THROW, so a
//      passing run is proof status touched none of them.

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyAgentStore, putAgent, type AgentRecord, type AgentStoreState, type LaunchRecord } from "../../src/agent-model";
import { save as saveAgents } from "../../src/agent-store-io";
import type { ClaimKey } from "../../src/claim-key-resolve";
import { runCli, type CliDeps } from "../../src/cli/main";
import type { StatusReport } from "../../src/status-model";
import { makeFakeHost, permissionScreen, type FakeHost } from "../support/fake-host";

const KEY = "/claimed/dir" as ClaimKey;
const CHECKED_AT = 1_700_000_000_000;

const cleanupDirs: string[] = [];
afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});
async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bakr-status-test-"));
  cleanupDirs.push(dir);
  return dir;
}

function agentRecord(id: string, over: Partial<AgentRecord> = {}): AgentRecord {
  return { id, name: undefined, directory: KEY, state: "on", createdAt: 1, birthSessionId: "birth", restoreTarget: { sessionId: `${id}-session`, shortId: `${id}-pane` }, ...over };
}

const storeOf = (agents: readonly AgentRecord[], launches: readonly LaunchRecord[] = []): AgentStoreState =>
  ({ ...agents.reduce((s, a) => putAgent(s, a), emptyAgentStore()), launches });

/**
 * Every dependency `status` must never reach for, wired to throw. `cwd` names
 * a directory that does not exist, so a `status` that resolved a claim key
 * would fail the run outright — which is the point: the command is documented
 * as valid from any cwd.
 */
function cliDeps(agentsPath: string, host: FakeHost, out: string[], err: string[]): CliDeps {
  const forbidden = (what: string) => () => { throw new Error(`status must never use ${what}`); };
  return {
    actions: { agentsPath, runCommand: host.runCommand, now: () => CHECKED_AT, generateAttemptId: forbidden("generateAttemptId"), randomBytes: forbidden("randomBytes") },
    adopt: { claimsPath: "/must/not/exist/claims.json", agentsPath, now: forbidden("adopt.now"), resolveInputs: { lstat: forbidden("lstat"), readlink: forbidden("readlink") }, lexicalInputs: { cwd: "/nonexistent/cwd", home: "/nonexistent" }, probeDeps: { stat: forbidden("stat") } },
    claimsPath: "/must/not/exist/claims.json",
    resolveInputs: { lstat: forbidden("lstat"), readlink: forbidden("readlink") },
    probeDeps: { stat: forbidden("stat") },
    cwd: "/nonexistent/cwd",
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stdout: (s) => { out.push(s); },
    stderr: (s) => { err.push(s); },
    prompt: forbidden("prompt") as unknown as CliDeps["prompt"],
    spawnAttach: forbidden("spawnAttach") as unknown as CliDeps["spawnAttach"],
    messenger: { message: forbidden("messenger") } as unknown as CliDeps["messenger"],
    permissions: { list: forbidden("permissions") } as unknown as CliDeps["permissions"],
  };
}

interface Run { code: number; report: StatusReport; out: string; err: string; host: FakeHost }

async function runStatus(setup: { agents?: readonly AgentRecord[]; launches?: readonly LaunchRecord[]; host?: FakeHost; malformedStore?: boolean; argv?: string[] }): Promise<Run & { agentsPath: string }> {
  const dir = await makeTempDir();
  const agentsPath = join(dir, "agents.json");
  if (setup.malformedStore) await writeFile(agentsPath, "{ not json", "utf8");
  else await saveAgents(agentsPath, storeOf(setup.agents ?? [], setup.launches ?? []));
  const host = setup.host ?? makeFakeHost();
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(setup.argv ?? ["status", "--json"], cliDeps(agentsPath, host, out, err));
  const text = out.join("");
  return { code, report: (setup.argv ?? ["status", "--json"]).includes("--json") ? JSON.parse(text) as StatusReport : ({} as StatusReport), out: text, err: err.join(""), host, agentsPath };
}

/** Puts a pane into the fake host and returns it, so a store record can be written to match (or deliberately not match) it. */
function paneFor(host: FakeHost, sessionId: string, over: { status?: "idle" | "working" | "blocked" | "done"; screen?: string } = {}) {
  return host.addPane({ cwd: KEY, sessionId, ...over });
}

test("a healthy host: every agent ok, problem null everywhere, exit 0", async () => {
  const host = makeFakeHost();
  const first = paneFor(host, "@one-session");
  const second = paneFor(host, "@two-session", { status: "working" });
  const { code, report } = await runStatus({
    host,
    agents: [
      agentRecord("@one", { restoreTarget: { sessionId: "@one-session", shortId: first.paneId } }),
      agentRecord("@two", { name: "rocketr", restoreTarget: { sessionId: "@two-session", shortId: second.paneId } }),
    ],
  });
  expect(code).toBe(0);
  expect(report.herdr).toEqual({ ok: true });
  expect(report.store).toEqual({ ok: true });
  expect(report.agents.map((a) => a.problem)).toEqual([null, null]);
  expect(report.agents.map((a) => a.ok)).toEqual([true, true]);
  expect(report.agents.map((a) => a.pane)).toEqual([first.paneId, second.paneId]);
  expect(report.agents.find((a) => a.id === "@two")!.herdrStatus).toBe("working");
  expect(report.duplicates).toEqual([]);
  expect(report.orphanPanes).toEqual([]);
  expect(report.blockedPrompts).toEqual([]);
  expect(report.version).toBe(1);
  expect(report.checkedAt).toBe(new Date(CHECKED_AT).toISOString());
});

test("STRICTLY READ-ONLY: only `herdr agent list` and `herdr agent read` run, and the store's bytes are unchanged", async () => {
  const host = makeFakeHost();
  const pane = paneFor(host, "@one-session");
  const dir = await makeTempDir();
  const agentsPath = join(dir, "agents.json");
  await saveAgents(agentsPath, storeOf([agentRecord("@one", { restoreTarget: { sessionId: "@one-session", shortId: pane.paneId } })]));
  const before = await readFile(agentsPath);

  const out: string[] = [];
  const code = await runCli(["status", "--json"], cliDeps(agentsPath, host, out, []));

  expect(code).toBe(0);
  const commands = host.calls.map((c) => c.slice(0, 3).join(" "));
  expect([...new Set(commands)].sort()).toEqual(["herdr agent list", "herdr agent read"]);
  expect(host.calls.filter((c) => c[2] === "list")).toHaveLength(1); // one listing, shared by the scan and the inventory
  expect(host.starts()).toEqual([]);
  expect(host.stops()).toEqual([]);
  expect(await readFile(agentsPath)).toEqual(before);
});

test("a herdr-read failure: exit 2, every agent ok: null, and NOTHING marked down", async () => {
  const host = makeFakeHost({ failListing: true });
  const { code, report, out } = await runStatus({ host, agents: [agentRecord("@one"), agentRecord("@two", { state: "off" })] });
  expect(code).toBe(2);
  expect(report.herdr.ok).toBe(false);
  expect(report.herdr).toMatchObject({ reason: expect.stringContaining("simulated listing failure") });
  expect(report.store).toEqual({ ok: true });
  expect(report.agents.map((a) => a.id)).toEqual(["@one", "@two"]);
  expect(report.agents.map((a) => a.ok)).toEqual([null, null]);
  expect(report.agents.map((a) => a.problem)).toEqual([null, null]);
  expect(out).toContain('"version": 1'); // the JSON is printed in every case
});

test("a store-read failure: exit 2, the reason on `store`, and no agents invented from the listing", async () => {
  const host = makeFakeHost();
  paneFor(host, "a-stranger");
  const { code, report } = await runStatus({ host, malformedStore: true });
  expect(code).toBe(2);
  expect(report.store.ok).toBe(false);
  expect(report.herdr).toEqual({ ok: true });
  expect(report.agents).toEqual([]);
  expect(report.orphanPanes).toEqual([]);
});

test("every problem code, end to end against the fake host", async () => {
  const host = makeFakeHost();
  const healthy = paneFor(host, "@healthy-session");
  const moved = paneFor(host, "@moved-session");
  const stranger = paneFor(host, "@stranger-session");
  const dupA = paneFor(host, "@dup-session");
  const dupB = paneFor(host, "@dup-session");
  const blocked = paneFor(host, "@blocked-session", { screen: permissionScreen("Bash", ["rm -rf /tmp/x"]) });

  const { code, report } = await runStatus({
    host,
    agents: [
      agentRecord("@healthy", { restoreTarget: { sessionId: "@healthy-session", shortId: healthy.paneId } }),
      agentRecord("@absent", { restoreTarget: { sessionId: "@absent-session", shortId: "w99:p1" } }),
      agentRecord("@wrongpane", { restoreTarget: { sessionId: "@moved-session", shortId: "w98:p1" } }),
      agentRecord("@wrongsession", { restoreTarget: { sessionId: "@gone-session", shortId: stranger.paneId } }),
      agentRecord("@dup", { restoreTarget: { sessionId: "@dup-session", shortId: dupA.paneId } }),
      agentRecord("@refused", { restoreTarget: { sessionId: "@refused-session", shortId: "w97:p1" } }),
      agentRecord("@blocked", { restoreTarget: { sessionId: "@blocked-session", shortId: blocked.paneId } }),
    ],
    launches: [{ attemptId: "attempt-33", agentId: "@refused", key: KEY, attemptKey: undefined, attemptedAt: CHECKED_AT - 5_000, launchShortId: undefined, error: "herdr refused the respawn" }],
  });

  expect(code).toBe(1);
  const codes = Object.fromEntries(report.agents.map((a) => [a.id, a.problem?.code ?? null]));
  expect(codes).toEqual({
    "@absent": "not-in-herdr",
    "@blocked": "blocked",
    "@dup": "duplicate-session",
    "@healthy": null,
    "@refused": "restore-refused",
    "@wrongpane": "wrong-pane",
    "@wrongsession": "wrong-session",
  });
  expect(report.agents.find((a) => a.id === "@blocked")!.blockedOn).toBe("permission");
  expect(report.blockedPrompts).toEqual([{ pane: blocked.paneId, agentId: "@blocked", kind: "permission", name: "Bash", excerpt: expect.stringContaining("Do you want to proceed?") }]);
  expect(report.duplicates).toEqual([{ sessionId: "@dup-session", panes: [dupA.paneId, dupB.paneId] }]);
  // `@moved-session` is an on agent's session (just in the wrong pane), so only the stranger's pane is orphaned.
  expect(report.orphanPanes).toEqual([{ pane: stranger.paneId, sessionId: "@stranger-session" }]);
  expect(moved.paneId).toBe(report.agents.find((a) => a.id === "@wrongpane")!.pane!);
  expect(report.unresolvedLaunches).toEqual([{ agentId: "@refused", attemptId: "attempt-33", attemptedAt: new Date(CHECKED_AT - 5_000).toISOString(), error: "herdr refused the respawn" }]);
});

test("a plain `bakr status` prints a short human summary of the same data", async () => {
  const host = makeFakeHost();
  const pane = paneFor(host, "@one-session");
  const { code, out } = await runStatus({
    host,
    argv: ["status"],
    agents: [agentRecord("@one", { name: "rocketr", restoreTarget: { sessionId: "@one-session", shortId: pane.paneId } }), agentRecord("@two")],
  });
  expect(code).toBe(1);
  expect(out).toContain(new Date(CHECKED_AT).toISOString());
  expect(out).toContain(`@one "rocketr" — on — pane ${pane.paneId} — ok`);
  expect(out).toContain("@two — on — pane @two-pane — PROBLEM: not-in-herdr: no herdr pane is running session @two-session");
  expect(out.startsWith("{")).toBe(false);
});

test("under 2s for 11 agents (requirement 5), with one listing and one screen read per pane", async () => {
  const host = makeFakeHost();
  const agents = Array.from({ length: 11 }, (_, i) => {
    const pane = paneFor(host, `@a${i}-session`);
    return agentRecord(`@a${i}`, { restoreTarget: { sessionId: `@a${i}-session`, shortId: pane.paneId } });
  });
  const started = Date.now();
  const { code, report } = await runStatus({ host, agents });
  const elapsed = Date.now() - started;
  expect(code).toBe(0);
  expect(report.agents).toHaveLength(11);
  expect(host.calls.filter((c) => c[2] === "list")).toHaveLength(1);
  expect(host.calls.filter((c) => c[2] === "read")).toHaveLength(11);
  expect(elapsed).toBeLessThan(2000);
});
