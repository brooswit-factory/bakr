// BAKR-27 (implementing story BAKR-26): B13a — "a recognised stale-cwd
// refusal is not an unresolved launch." Through the REAL daemon entry
// point (`runReconcileCycle`), never a hand-written replica of its report
// loop. Falsifier stated per test.
//
// THE BUG THIS FILE PINNED (as merged at 587a442e): `runReconcileCycle`'s
// "unresolved launch" report loop logged EVERY record `unresolvedLaunches`
// returns, at error level, EVERY cycle — including a `claude respawn`
// attempt claude itself refused with the stale-cwd shape ("working directory
// no longer exists"), whose forkFrom/fresh escape had since succeeded.
//
// UNDER HERDR: a restore is `claude --resume <session>` in a new pane, which
// never produces `claude respawn`'s stale-cwd refusal, so this build can no
// longer CREATE such a record. The tests that existed only to drive that
// refusal live through the reconcile loop (the forkFrom arm, the fresh arm,
// the escape-launch-fails control and the could-not-tell control) were
// retired rather than kept alive by faking the old error text. What still
// applies, and is kept:
//   - AC6: a stale-cwd respawn record ALREADY ON DISK (left by an older
//     build) is suppressed by the same divergence inference, and the
//     negative control that it is keyed on divergence, not on the text.
//   - AC3: an unrecognised restore failure never falls through to a fork
//     or fresh launch, and stays reported every cycle.

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
import type { TranscriptProbeDeps } from "../../src/transcript-probe";
import type { RunCommand } from "../../src/spawn";
import { makeFakeHost } from "../support/fake-host";

const alwaysPresentProbeDeps: OrphanProbeDeps = { stat: async () => ({ dev: 1, ino: 1, isDirectory: () => true }) };
const KEY = "/claimed/dir" as ClaimKey;
const AGENT_ID = "@moved-agent";
const OLD_SHORT_ID = "oldshort";
const OLD_SESSION_ID = "old-session-uuid";
/** The text an OLDER build recorded from `claude respawn`'s stale-cwd refusal — only ever seeded on disk here, never produced by a fake. */
const STALE_CWD_ERROR = `respawn exited 1: Couldn't start a background session (working directory no longer exists or is not accessible: /tmp/old-claimed-dir)`;
const noTranscript: TranscriptProbeDeps = { listProjectDirs: async () => ({ ok: true, dirs: [] }), transcriptExistsIn: async () => ({ ok: true, exists: false }) };

const cleanupDirs: string[] = [];
afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bakr-stale-cwd-report-test-"));
  cleanupDirs.push(dir);
  return dir;
}

function agentWithRestoreTarget(): AgentRecord {
  return {
    id: AGENT_ID,
    name: undefined,
    directory: KEY,
    state: "on",
    createdAt: 1,
    birthSessionId: OLD_SESSION_ID,
    restoreTarget: { sessionId: OLD_SESSION_ID, shortId: OLD_SHORT_ID },
  };
}

function baseDeps(dir: string, runCommand: RunCommand, transcriptProbeDeps: TranscriptProbeDeps): DaemonDeps {
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
    transcriptProbeDeps,
    launchConfigDeps: { readConfigFile: async () => undefined },
  };
}

async function runCycles(deps: DaemonDeps, count: number): Promise<{ capturedLines: string[]; results: Awaited<ReturnType<typeof runReconcileCycle>>[] }> {
  const capturedLines: string[] = [];
  const results: Awaited<ReturnType<typeof runReconcileCycle>>[] = [];
  const originalConsoleLog = console.log;
  console.log = (...args: unknown[]) => {
    capturedLines.push(args.map(String).join(" "));
  };
  let state: DaemonState = initialDaemonState();
  try {
    for (let i = 0; i < count; i++) {
      const result = await runReconcileCycle(state, deps);
      results.push(result);
      state = { claimDegraded: result.claimDegraded, agentsDegraded: result.agentsDegraded, orphanReportSignatures: result.orphanReportSignatures };
    }
  } finally {
    console.log = originalConsoleLog;
  }
  return { capturedLines, results };
}

describe("B13a negative control (AC3): an unrecognised restore failure stays exactly as loud as before", () => {
  test("a resume that fails to start never falls through to a fork or a fresh launch, and stays reported every cycle", async () => {
    const dir = await makeTempDir();
    await saveClaims(join(dir, "claims.json"), claim(emptyStore(), KEY, 1).state);
    await saveAgents(join(dir, "agents.json"), putAgent(emptyAgentStore(), agentWithRestoreTarget()));
    const fake = makeFakeHost({ failStart: "No conversation found with session ID: old-session-uuid" });
    const deps = baseDeps(dir, fake.runCommand, noTranscript);

    const { capturedLines, results } = await runCycles(deps, 4);

    expect(results.every((r) => !r.skippedListingFailed)).toBe(true); // every cycle genuinely ran
    // Exactly ONE start, ever: the restore itself. Falsifier: an escape would be a second start
    // carrying `--fork-session`, or a bare fresh one (no transcript was reported, so "fresh" is what it would pick).
    expect(fake.starts()).toEqual([["--resume", OLD_SESSION_ID]]);
    // 4 cycles run, but cycle 1's report loop reads a snapshot taken
    // BEFORE that same cycle's own dispatch creates the record (see
    // daemon.ts's own comment on `peeked`) — so only cycles 2-4 report it.
    const unresolvedLines = capturedLines.filter((l) => l.includes("unresolved launch for agent") && l.includes(AGENT_ID));
    expect(unresolvedLines.length).toBeGreaterThanOrEqual(3);
  });
});

describe("B13a AC6: a stale respawn(X) record already on disk, written by a PRE-B13a build, is suppressed by the SAME inference — no migration, no write, needed", () => {
  test("a pre-existing failed respawn record whose shortId no longer matches the agent's CURRENT restoreTarget (because an escape already resolved under the old code) stops being reported without any dispatch happening in THIS run at all", async () => {
    const dir = await makeTempDir();
    await saveClaims(join(dir, "claims.json"), claim(emptyStore(), KEY, 1).state);

    // Simulates exactly what 587a442e's own code left behind: the agent's
    // restoreTarget already advanced to the NEW session (the escape
    // resolved, under the OLD, unfixed daemon build), but the ORIGINAL
    // failed respawn(oldShortId) record is still sitting in the store,
    // never cleared, because nothing before this ticket ever cleared it.
    let state = emptyAgentStore();
    state = putAgent(state, { id: AGENT_ID, name: undefined, directory: KEY, state: "on", createdAt: 1, birthSessionId: OLD_SESSION_ID, restoreTarget: { sessionId: "new-session-uuid", shortId: "newshort" } });
    state = {
      ...state,
      launches: [{ attemptId: "pre-b13a-attempt", agentId: AGENT_ID, key: KEY, attemptKey: { kind: "respawn", shortId: OLD_SHORT_ID }, attemptedAt: 1, launchShortId: undefined, error: STALE_CWD_ERROR }],
    };
    await saveAgents(join(dir, "agents.json"), state);

    // The listing already shows the (already-escaped, already-resolved)
    // current session as alive — nothing left to dispatch this run at all;
    // this test's only question is the REPORT loop's treatment of the
    // stale on-disk record.
    const fake = makeFakeHost();
    fake.addPane({ cwd: KEY, sessionId: "new-session-uuid" });
    const runCommand: RunCommand = async (argv, opts) => {
      const listing = (argv[0] === "herdr" && argv[1] === "agent" && argv[2] === "list") || (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "process-info") || (argv[0] === "claude" && argv[1] === "agents");
      if (!listing) throw new Error(`unexpected argv (nothing should be dispatched): ${JSON.stringify(argv)}`);
      return fake.runCommand(argv, opts);
    };
    const deps = baseDeps(dir, runCommand, noTranscript);

    const { capturedLines, results } = await runCycles(deps, 3);

    expect(results.every((r) => !r.skippedListingFailed)).toBe(true); // every cycle reached the report loop — not a vacuous pass from a skipped cycle
    const unresolvedLines = capturedLines.filter((l) => l.includes("unresolved launch for agent") && l.includes(AGENT_ID));
    expect(unresolvedLines).toEqual([]); // AC6: suppressed from cycle 1 — no "one loud report" is owed here either, since THIS run never issued the refusal itself

    // The record is untouched on disk — this is a reporting fix, not a clear.
    const finalStore = await loadAgents(join(dir, "agents.json"));
    if (finalStore.status !== "loaded") throw new Error("expected loaded store");
    expect(finalStore.state.launches).toHaveLength(1);
    expect(finalStore.state.launches[0]?.error).toBe(STALE_CWD_ERROR);
  });

  test("NEGATIVE CONTROL: an identical-shaped stale respawn record whose shortId STILL matches the agent's current restoreTarget (no escape ever resolved) is NOT suppressed — proves the suppression is keyed on divergence, not merely on the error text", async () => {
    const dir = await makeTempDir();
    await saveClaims(join(dir, "claims.json"), claim(emptyStore(), KEY, 1).state);
    let state = emptyAgentStore();
    state = putAgent(state, agentWithRestoreTarget());
    state = {
      ...state,
      launches: [{ attemptId: "still-current-attempt", agentId: AGENT_ID, key: KEY, attemptKey: { kind: "respawn", shortId: OLD_SHORT_ID }, attemptedAt: 1, launchShortId: undefined, error: STALE_CWD_ERROR }],
    };
    await saveAgents(join(dir, "agents.json"), state);

    const fake = makeFakeHost();
    const deps = baseDeps(dir, fake.runCommand, noTranscript);

    const { capturedLines } = await runCycles(deps, 2);

    const unresolvedLines = capturedLines.filter((l) => l.includes("unresolved launch for agent") && l.includes(AGENT_ID));
    expect(unresolvedLines).toHaveLength(2); // still reported, every cycle
    // The OLD record's own attemptKey still matches hasLaunchRecordFor's guard, so no fresh attempt is ever made.
    expect(fake.starts()).toEqual([]);
  });
});
