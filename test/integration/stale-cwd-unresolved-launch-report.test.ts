// BAKR-27 (implementing story BAKR-26): B13a — "a recognised stale-cwd
// refusal is not an unresolved launch." Through the REAL daemon entry
// point (`runReconcileCycle`), never a hand-written replica of its report
// loop — same discipline as fork-from-transcript-check.test.ts, which this
// file's fixtures are deliberately modeled on, extended across MULTIPLE
// cycles (that file only ever ran one). Falsifier stated per test.
//
// THE BUG THIS FILE PINS (as merged at 587a442e, before this ticket's
// fix): `runReconcileCycle`'s "unresolved launch" report loop logs EVERY
// record `unresolvedLaunches` returns, at error level, EVERY cycle,
// unconditionally (suppressed only by directory classification, BAKR-24
// Q4) — including the respawn attempt claude itself refused BEFORE
// starting anything, whose escape (forkFrom, or fresh on positive
// no-transcript evidence) has since succeeded. Run this suite's first two
// tests against 587a442e (`git stash` this ticket's own diff, or check out
// that commit in a scratch worktree) to see them fail with repeated
// "unresolved launch for agent" lines across cycles 2+; they pass on this
// head.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyAgentStore, putAgent, unresolvedLaunches, type AgentRecord } from "../../src/agent-model";
import { save as saveAgents, load as loadAgents } from "../../src/agent-store-io";
import { claim, emptyStore } from "../../src/claim-model";
import { save as saveClaims } from "../../src/claim-store-io";
import { initialDaemonState, runReconcileCycle, type DaemonDeps, type DaemonState } from "../../src/daemon";
import type { ClaimKey } from "../../src/claim-key-resolve";
import type { OrphanProbeDeps } from "../../src/orphan-probe";
import type { TranscriptProbeDeps } from "../../src/transcript-probe";
import type { RunCommand } from "../../src/spawn";

const alwaysPresentProbeDeps: OrphanProbeDeps = { stat: async () => ({ dev: 1, ino: 1, isDirectory: () => true }) };
const KEY = "/claimed/dir" as ClaimKey;
const AGENT_ID = "@moved-agent";
const OLD_SHORT_ID = "oldshort";
const OLD_SESSION_ID = "old-session-uuid";
const STALE_CWD_ERROR = `respawn exited 1: Couldn't start a background session (working directory no longer exists or is not accessible: /tmp/old-claimed-dir)`;

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
  };
}

/**
 * `claude respawn <OLD_SHORT_ID>` ALWAYS refuses with the recognised
 * stale-cwd shape (the directory never "un-moves" in these tests — the
 * escape is what's under test, not recovery of the original short id).
 * `systemd-run` mints a NEW short id/session id, immediately listed with
 * THIS TEST PROCESS'S OWN pid — a real, independently-verifiable pid
 * (mirrors daemon.test.ts's own fake), so once a later cycle's listing
 * resolves the escape's pending record, the agent reads back `alive` and
 * nothing further is dispatched — the same steady state the ticket's own
 * bug report describes ("the second restore was a plain respawn").
 */
function makeFakeClaude() {
  const listing: Array<{ id: string; sessionId: string; cwd: string; startedAt: number; kind: string; pid?: number }> = [];
  let nextShortId = 0;
  const runCommand: RunCommand = async (argv, opts) => {
    if (argv[0] === "claude" && argv[1] === "agents") {
      return { exitCode: 0, stdout: JSON.stringify(listing), stderr: "" };
    }
    if (argv[0] === "claude" && argv[1] === "stop") {
      throw new Error(`FALSIFIER TRIPPED: this loop must never issue a stop (B7) — got: ${JSON.stringify(argv)}`);
    }
    if (argv[0] === "claude" && argv[1] === "respawn") {
      return { exitCode: 1, stdout: "", stderr: STALE_CWD_ERROR };
    }
    if (argv[0] === "systemd-run") {
      const shortId = `newshort-${nextShortId++}`;
      const sessionId = `new-session-${shortId}`;
      listing.push({ id: shortId, sessionId, cwd: opts.cwd ?? "", startedAt: 1, kind: "background", pid: process.pid });
      return { exitCode: 0, stdout: `backgrounded · ${shortId} (idle — send a prompt to start)\n`, stderr: "" };
    }
    throw new Error(`fake runCommand: unexpected argv ${JSON.stringify(argv)}`);
  };
  return { runCommand, listing };
}

async function seed(dir: string): Promise<void> {
  let state = emptyAgentStore();
  state = putAgent(state, agentWithRestoreTarget());
  await saveClaims(join(dir, "claims.json"), claim(emptyStore(), KEY, 1).state);
  await saveAgents(join(dir, "agents.json"), state);
}

async function runCycles(deps: DaemonDeps, count: number): Promise<{ capturedLines: string[] }> {
  const capturedLines: string[] = [];
  const originalConsoleLog = console.log;
  console.log = (...args: unknown[]) => {
    capturedLines.push(args.map(String).join(" "));
  };
  let state: DaemonState = initialDaemonState();
  try {
    for (let i = 0; i < count; i++) {
      const result = await runReconcileCycle(state, deps);
      state = { claimDegraded: result.claimDegraded, agentsDegraded: result.agentsDegraded, orphanReportSignatures: result.orphanReportSignatures };
    }
  } finally {
    console.log = originalConsoleLog;
  }
  return { capturedLines };
}

describe("B13a (AC1/AC2): a recognised stale-cwd refusal whose escape succeeded is not an unresolved launch", () => {
  test("forkFrom arm (has-transcript): at least 3 reconcile cycles after the escape log ZERO 'unresolved launch' lines for the agent; the stale-cwd refusal itself is logged exactly once, never again", async () => {
    const dir = await makeTempDir();
    await seed(dir);
    const fake = makeFakeClaude();
    const hasTranscript: TranscriptProbeDeps = { listProjectDirs: async () => ({ ok: true, dirs: ["-tmp-old"] }), transcriptExistsIn: async () => ({ ok: true, exists: true }) };
    const deps = baseDeps(dir, fake.runCommand, hasTranscript);

    // Cycle 1: respawn refused (stale cwd), forkFrom escape dispatched and
    // succeeds (systemd-run mints a new short id). Cycles 2-6: at least 3
    // full cycles AFTER the escape, well past the cycle that resolves its
    // pending launch record against the listing.
    const { capturedLines } = await runCycles(deps, 6);

    const unresolvedLines = capturedLines.filter((l) => l.includes("unresolved launch for agent") && l.includes(AGENT_ID));
    expect(unresolvedLines).toEqual([]); // AC2: zero, across every post-escape cycle

    const staleCwdRefusalLines = capturedLines.filter((l) => l.includes(AGENT_ID) && l.includes("respawn REFUSED with the recognised stale-cwd shape"));
    expect(staleCwdRefusalLines).toHaveLength(1); // AC2: reported once, never again

    // Sanity: the escape actually happened and resolved (falsifier for a
    // vacuously-passing test — if the escape never fired, there would be
    // no failed respawn record to suppress in the first place).
    const finalStore = await loadAgents(join(dir, "agents.json"));
    if (finalStore.status !== "loaded") throw new Error("expected loaded store");
    const agent = finalStore.state.agents[AGENT_ID];
    expect(agent?.restoreTarget?.sessionId).not.toBe(OLD_SESSION_ID);
    const failedRespawnRecord = finalStore.state.launches.find((l) => l.attemptKey?.kind === "respawn" && (l.attemptKey as { shortId: string }).shortId === OLD_SHORT_ID);
    expect(failedRespawnRecord?.error).toBeDefined(); // B13: the record ITSELF is never cleared/removed by the loop
    expect(unresolvedLaunches(finalStore.state)).toContain(failedRespawnRecord!); // still "unresolved" by the raw predicate — only the REPORT is suppressed
  });

  test("fresh arm (no-transcript, positive evidence): at least 3 reconcile cycles after the escape log ZERO 'unresolved launch' lines for the agent", async () => {
    const dir = await makeTempDir();
    await seed(dir);
    const fake = makeFakeClaude();
    const noTranscript: TranscriptProbeDeps = { listProjectDirs: async () => ({ ok: true, dirs: [] }), transcriptExistsIn: async () => ({ ok: true, exists: false }) };
    const deps = baseDeps(dir, fake.runCommand, noTranscript);

    const { capturedLines } = await runCycles(deps, 6);

    const unresolvedLines = capturedLines.filter((l) => l.includes("unresolved launch for agent") && l.includes(AGENT_ID));
    expect(unresolvedLines).toEqual([]);

    const staleCwdRefusalLines = capturedLines.filter((l) => l.includes(AGENT_ID) && l.includes("respawn REFUSED with the recognised stale-cwd shape"));
    expect(staleCwdRefusalLines).toHaveLength(1);
    // The fresh arm's own loud "abandoned session" line names it too — still exactly once.
    const abandonedLines = capturedLines.filter((l) => l.includes(`Session ${OLD_SESSION_ID} was CONFIRMED to have no resumable transcript`));
    expect(abandonedLines).toHaveLength(1);

    const finalStore = await loadAgents(join(dir, "agents.json"));
    if (finalStore.status !== "loaded") throw new Error("expected loaded store");
    const agent = finalStore.state.agents[AGENT_ID];
    expect(agent?.restoreTarget?.sessionId).not.toBe(OLD_SESSION_ID);
  });
});

describe("B13a negative controls (AC3): the failure paths this fix must NOT touch stay exactly as loud as before", () => {
  test("the escape launch itself fails: the resulting forkFrom-keyed record is a genuinely unresolved launch, reported every cycle, forever — never suppressed", async () => {
    const dir = await makeTempDir();
    await seed(dir);
    const runCommand: RunCommand = async (argv) => {
      if (argv[0] === "claude" && argv[1] === "agents") return { exitCode: 0, stdout: "[]", stderr: "" };
      if (argv[0] === "claude" && argv[1] === "respawn") return { exitCode: 1, stdout: "", stderr: STALE_CWD_ERROR };
      if (argv[0] === "systemd-run") return { exitCode: 1, stdout: "", stderr: "systemd-run: simulated launch failure" };
      throw new Error(`unexpected argv: ${JSON.stringify(argv)}`);
    };
    const hasTranscript: TranscriptProbeDeps = { listProjectDirs: async () => ({ ok: true, dirs: ["-tmp-old"] }), transcriptExistsIn: async () => ({ ok: true, exists: true }) };
    const deps = baseDeps(dir, runCommand, hasTranscript);

    const { capturedLines } = await runCycles(deps, 4);

    // Neither record is suppressed here: the escape's own launch() call
    // FAILED, so restoreTarget never advances, so
    // isSupersededStaleCwdRespawnFailure's divergence check never fires for
    // the ORIGINAL respawn(oldShortId) record either — it stays reported
    // right alongside the escape's own new forkFrom(sessionId) failure.
    // Both stay reported, every cycle.
    const unresolvedLines = capturedLines.filter((l) => l.includes("unresolved launch for agent") && l.includes(AGENT_ID));
    // The respawn-keyed record's own error text is STALE_CWD_ERROR
    // ("Couldn't start a background session ..."), distinct from the
    // forkFrom-keyed record's ("launch exited ...: systemd-run: simulated
    // launch failure") — filtering on it names the ORIGINAL
    // respawn(oldShortId) record directly, rather than relying on a raw
    // line count to stand in for "this specific record is still reported".
    const respawnKeyedLines = unresolvedLines.filter((l) => l.includes("Couldn't start a background session"));
    expect(respawnKeyedLines.length).toBeGreaterThanOrEqual(3); // never suppressed — restoreTarget never advanced, since the escape's own launch failed
    expect(unresolvedLines.length).toBeGreaterThanOrEqual(4); // both stranded records combined, at least one line per post-dispatch cycle

    const finalStore = await loadAgents(join(dir, "agents.json"));
    if (finalStore.status !== "loaded") throw new Error("expected loaded store");
    const forkRecord = finalStore.state.launches.find((l) => l.attemptKey?.kind === "forkFrom");
    expect(forkRecord?.error).toBeDefined(); // the escape's own failure — a genuinely unresolved launch
    const agent = finalStore.state.agents[AGENT_ID];
    expect(agent?.restoreTarget?.sessionId).toBe(OLD_SESSION_ID); // never advanced — the escape never succeeded
  });

  test("could-not-tell: refused, recorded, reported every cycle — no escape is ever attempted", async () => {
    const dir = await makeTempDir();
    await seed(dir);
    const capturedLaunchArgv: string[][] = [];
    const runCommand: RunCommand = async (argv) => {
      if (argv[0] === "claude" && argv[1] === "agents") return { exitCode: 0, stdout: "[]", stderr: "" };
      if (argv[0] === "claude" && argv[1] === "respawn") return { exitCode: 1, stdout: "", stderr: STALE_CWD_ERROR };
      if (argv[0] === "systemd-run") {
        capturedLaunchArgv.push(argv);
        return { exitCode: 0, stdout: "backgrounded · newshort\n", stderr: "" };
      }
      throw new Error(`unexpected argv: ${JSON.stringify(argv)}`);
    };
    const couldNotTell: TranscriptProbeDeps = { listProjectDirs: async () => ({ ok: false, reason: "EACCES" }), transcriptExistsIn: async () => ({ ok: true, exists: false }) };
    const deps = baseDeps(dir, runCommand, couldNotTell);

    const { capturedLines } = await runCycles(deps, 4);

    expect(capturedLaunchArgv).toHaveLength(0); // no escape attempted, ever — falsifier: could-not-tell folded into no-transcript would show a launch here
    // 4 cycles run, but cycle 1's report loop reads a snapshot taken
    // BEFORE that same cycle's own dispatch creates the record (see
    // daemon.ts's own comment on `peeked`) — so only cycles 2-4 report it.
    const unresolvedLines = capturedLines.filter((l) => l.includes("unresolved launch for agent") && l.includes(AGENT_ID));
    expect(unresolvedLines.length).toBeGreaterThanOrEqual(3);
  });

  test("an unrecognised respawn failure never falls through to forkFrom, and stays reported every cycle", async () => {
    const dir = await makeTempDir();
    await seed(dir);
    const capturedLaunchArgv: string[][] = [];
    const runCommand: RunCommand = async (argv) => {
      if (argv[0] === "claude" && argv[1] === "agents") return { exitCode: 0, stdout: "[]", stderr: "" };
      if (argv[0] === "claude" && argv[1] === "respawn") return { exitCode: 1, stdout: "", stderr: "No job matching 'oldshort'" };
      if (argv[0] === "systemd-run") {
        capturedLaunchArgv.push(argv);
        return { exitCode: 0, stdout: "backgrounded · newshort\n", stderr: "" };
      }
      throw new Error(`unexpected argv: ${JSON.stringify(argv)}`);
    };
    const deps = baseDeps(dir, runCommand, { listProjectDirs: async () => ({ ok: true, dirs: [] }), transcriptExistsIn: async () => ({ ok: true, exists: false }) });

    const { capturedLines } = await runCycles(deps, 4);

    expect(capturedLaunchArgv).toHaveLength(0); // never escapes on an unrecognised failure
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
    const runCommand: RunCommand = async (argv) => {
      if (argv[0] === "claude" && argv[1] === "agents") return { exitCode: 0, stdout: JSON.stringify([{ id: "newshort", sessionId: "new-session-uuid", cwd: KEY, startedAt: 1, kind: "background", pid: process.pid }]), stderr: "" };
      throw new Error(`unexpected argv (nothing should be dispatched): ${JSON.stringify(argv)}`);
    };
    const deps = baseDeps(dir, runCommand, { listProjectDirs: async () => ({ ok: true, dirs: [] }), transcriptExistsIn: async () => ({ ok: true, exists: false }) });

    const { capturedLines } = await runCycles(deps, 3);

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
    state = putAgent(state, { id: AGENT_ID, name: undefined, directory: KEY, state: "on", createdAt: 1, birthSessionId: OLD_SESSION_ID, restoreTarget: { sessionId: OLD_SESSION_ID, shortId: OLD_SHORT_ID } });
    state = {
      ...state,
      launches: [{ attemptId: "still-current-attempt", agentId: AGENT_ID, key: KEY, attemptKey: { kind: "respawn", shortId: OLD_SHORT_ID }, attemptedAt: 1, launchShortId: undefined, error: STALE_CWD_ERROR }],
    };
    await saveAgents(join(dir, "agents.json"), state);

    const runCommand: RunCommand = async (argv) => {
      if (argv[0] === "claude" && argv[1] === "agents") return { exitCode: 0, stdout: "[]", stderr: "" };
      if (argv[0] === "claude" && argv[1] === "respawn") return { exitCode: 1, stdout: "", stderr: STALE_CWD_ERROR };
      if (argv[0] === "systemd-run") return { exitCode: 1, stdout: "", stderr: "simulated failure — keep restoreTarget from ever advancing" };
      throw new Error(`unexpected argv: ${JSON.stringify(argv)}`);
    };
    const deps = baseDeps(dir, runCommand, { listProjectDirs: async () => ({ ok: true, dirs: [] }), transcriptExistsIn: async () => ({ ok: true, exists: false }) });

    const { capturedLines } = await runCycles(deps, 2);

    const unresolvedLines = capturedLines.filter((l) => l.includes("unresolved launch for agent") && l.includes(AGENT_ID));
    expect(unresolvedLines.length).toBeGreaterThan(0); // still reported — the OLD record's own attemptKey still matches hasLaunchRecordFor's guard too, so a fresh attempt is blocked and this exact record keeps showing up
  });
});
