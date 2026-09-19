// B13 (epic ruling, 2026-09-11): "only an explicit operator action may
// clear a failed or given-up launch record; the reconcile loop never does
// ... for the loop, the daemon's give-up stays final."
//
// AMENDED (BAKR-33, 2026-09-18, reviewer lead-bakr): that rule is no longer
// absolute. The escalation on BAKR-33 (yappr-3, post-power-loss) measured
// that it left a healthy `on` agent down forever after a host reboot: its
// only stale FAILED launch record named a pane that could not possibly
// exist any more, yet the daemon never looked again. The one narrow,
// bounded exception now shipped: on the FIRST reconcile cycle since THIS
// PROCESS started, AND only when a fresh liveness check this same cycle
// independently verifies the record's target `absent` right now (never on
// `alive` or `not-verifiable`), `decideAndBeginForAgent` supersedes that
// one record (`clearFailedLaunchRecord`) and attempts a normal restore —
// the daemon's own equivalent of an operator running `on` again after a
// restart. See `clearFailedLaunchRecord`'s own doc (agent-model.ts) and
// `DaemonState.isFirstCycle`'s own doc (daemon.ts) for the full reasoning.
//
// What did NOT change: every cycle after the first still treats an
// existing FAILED record as permanent — B7's "never retried automatically"
// stays intact for the whole rest of a process's life. This file's job
// is no longer "prove `daemon.ts` can never call `clearFailedLaunchRecord`
// at all" (a static grep can no longer make that claim, since it now does)
// — it is "prove the exception is exactly as narrow as claimed": bounded to
// one cycle, gated on verified absence, and no looser than that.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyAgentStore, putAgent, type AgentRecord } from "../../src/agent-model";
import { save as saveAgents, load as loadAgents } from "../../src/agent-store-io";
import { claim, emptyStore } from "../../src/claim-model";
import { save as saveClaims } from "../../src/claim-store-io";
import { initialDaemonState, runReconcileCycle, type DaemonDeps, type DaemonState } from "../../src/daemon";
import type { ClaimKey } from "../../src/claim-key-resolve";
import type { OrphanProbeDeps } from "../../src/orphan-probe";
import type { RunCommand } from "../../src/spawn";
import { makeFakeHost } from "../support/fake-host";

const alwaysPresentProbeDeps: OrphanProbeDeps = { stat: async () => ({ dev: 1, ino: 1, isDirectory: () => true }) };
const KEY = "/claimed/dir" as ClaimKey;
const AGENT_ID = "@wedge-agent";
const STALE_SHORT_ID = "long-gone-pane";
const SESSION_ID = "wedge-session-uuid";

const cleanupDirs: string[] = [];
afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});
async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bakr-no-wedge-clear-test-"));
  cleanupDirs.push(dir);
  return dir;
}

function agentWithStaleFailedRecord(): { agent: AgentRecord; error: string } {
  return {
    agent: { id: AGENT_ID, name: undefined, directory: KEY, state: "on", createdAt: 1, birthSessionId: SESSION_ID, restoreTarget: { sessionId: SESSION_ID, shortId: STALE_SHORT_ID } },
    error: `respawn refused: TOCTOU re-check reported "alive" for session ${STALE_SHORT_ID}`,
  };
}

async function seed(): Promise<string> {
  const dir = await makeTempDir();
  await saveClaims(join(dir, "claims.json"), claim(emptyStore(), KEY, 1).state);
  const { agent, error } = agentWithStaleFailedRecord();
  let state = putAgent(emptyAgentStore(), agent);
  state = { ...state, launches: [{ attemptId: "stale-attempt", agentId: AGENT_ID, key: KEY, attemptKey: { kind: "respawn", shortId: STALE_SHORT_ID }, attemptedAt: 1, launchShortId: undefined, error }] };
  await saveAgents(join(dir, "agents.json"), state);
  return dir;
}

function daemonDeps(dir: string, runCommand: RunCommand): DaemonDeps {
  let counter = 0;
  return {
    runCommand,
    claimsPath: join(dir, "claims.json"),
    agentsPath: join(dir, "agents.json"),
    sessionSlotsPath: join(dir, "session-slots.json"),
    now: () => 1_700_000_000_000,
    generateAttemptId: () => `attempt-${counter++}`,
    randomBytes: (n: number) => new Uint8Array(n).fill(1),
    probeDeps: alwaysPresentProbeDeps,
    launchConfigDeps: { readConfigFile: async () => undefined },
  };
}

async function launchesFor(dir: string): Promise<readonly { readonly attemptId: string; readonly error: string | undefined }[]> {
  const loaded = await loadAgents(join(dir, "agents.json"));
  if (loaded.status !== "loaded") throw new Error("expected loaded store");
  return loaded.state.launches.map((l) => ({ attemptId: l.attemptId, error: l.error }));
}

describe("BAKR-33: the reboot exception is bounded to the FIRST cycle, gated on verified absence — never looser", () => {
  test("first cycle, target verified ABSENT (no panes at all — a reboot): the stale record is superseded and a normal restore proceeds", async () => {
    const dir = await seed();
    const fake = makeFakeHost(); // no panes — genuinely nothing running, exactly the post-reboot shape

    const result = await runReconcileCycle(initialDaemonState(), daemonDeps(dir, fake.runCommand));

    expect(fake.starts()[0]!.slice(0, 2)).toEqual(["--resume", SESSION_ID]); // FALSIFIER: without this fix, respawnSession is never called at all
    expect(result.restored).toEqual([{ agentId: AGENT_ID, key: KEY, sessionId: SESSION_ID }]);
    const launches = await launchesFor(dir);
    expect(launches.some((l) => l.attemptId === "stale-attempt")).toBe(false); // the stale record is gone, not merely superseded-and-kept
  });

  test("NEGATIVE CONTROL — second cycle: an IDENTICAL stale record, still on its first daemon-life cycle's own successor, is NOT superseded — B7/B13 stays intact past cycle one", async () => {
    const dir = await seed();
    const fake = makeFakeHost();
    const deps = daemonDeps(dir, fake.runCommand);

    const first = await runReconcileCycle(initialDaemonState(), deps);
    // Re-seed an identical stale record (as if the daemon had just given up again on some OTHER key) to isolate cycle-2 behavior from cycle-1's own resolution.
    const { agent, error } = agentWithStaleFailedRecord();
    let state = putAgent(emptyAgentStore(), { ...agent, restoreTarget: { sessionId: SESSION_ID, shortId: STALE_SHORT_ID } });
    state = { ...state, launches: [{ attemptId: "second-stale-attempt", agentId: AGENT_ID, key: KEY, attemptKey: { kind: "respawn", shortId: STALE_SHORT_ID }, attemptedAt: 1, launchShortId: undefined, error }] };
    await saveAgents(join(dir, "agents.json"), state);
    const secondFake = makeFakeHost(); // still no panes — target still verifies absent

    const secondState: DaemonState = { claimDegraded: first.claimDegraded, agentsDegraded: first.agentsDegraded, orphanReportSignatures: first.orphanReportSignatures, isFirstCycle: first.isFirstCycle ?? false };
    expect(secondState.isFirstCycle).toBe(false); // sanity: cycle 1 really did consume the one-time flag
    const second = await runReconcileCycle(secondState, daemonDeps(dir, secondFake.runCommand));

    expect(secondFake.starts()).toEqual([]); // FALSIFIER: a start here would mean the exception re-armed on a later cycle
    expect(second.restored).toEqual([]);
    const launches = await launchesFor(dir);
    expect(launches.map((l) => l.attemptId)).toEqual(["second-stale-attempt"]); // untouched — still permanently blocked, exactly as pre-BAKR-33
  });

  test("NEGATIVE CONTROL — first cycle, target verified ALIVE (an operator is using it): NOT superseded, even though it is cycle one", async () => {
    const dir = await seed();
    const fake = makeFakeHost();
    fake.addPane({ cwd: KEY, sessionId: SESSION_ID }); // the session IS live right now, in some pane

    const result = await runReconcileCycle(initialDaemonState(), daemonDeps(dir, fake.runCommand));

    expect(fake.starts()).toEqual([]); // FALSIFIER: superseding on "alive" would kill and restart a live, in-use session
    expect(result.restored).toEqual([]);
    const launches = await launchesFor(dir);
    expect(launches.map((l) => l.attemptId)).toEqual(["stale-attempt"]); // untouched
  });

  test("NEGATIVE CONTROL — first cycle, a still-PENDING (never-failed) record at the same key: never superseded, never double-launched", async () => {
    const dir = await makeTempDir();
    await saveClaims(join(dir, "claims.json"), claim(emptyStore(), KEY, 1).state);
    const agent: AgentRecord = { id: AGENT_ID, name: undefined, directory: KEY, state: "on", createdAt: 1, birthSessionId: SESSION_ID, restoreTarget: { sessionId: SESSION_ID, shortId: STALE_SHORT_ID } };
    let state = putAgent(emptyAgentStore(), agent);
    state = { ...state, launches: [{ attemptId: "in-flight-attempt", agentId: AGENT_ID, key: KEY, attemptKey: { kind: "respawn", shortId: STALE_SHORT_ID }, attemptedAt: 1_700_000_000_000, launchShortId: undefined, error: undefined }] };
    await saveAgents(join(dir, "agents.json"), state);
    const fake = makeFakeHost(); // absent, same as the positive case — the only difference is error === undefined

    const result = await runReconcileCycle(initialDaemonState(), daemonDeps(dir, fake.runCommand));

    expect(fake.starts()).toEqual([]); // FALSIFIER: a start here would double-launch a genuinely in-flight attempt (AC4)
    expect(result.restored).toEqual([]);
    const launches = await launchesFor(dir);
    expect(launches.map((l) => l.attemptId)).toEqual(["in-flight-attempt"]); // untouched
  });
});
