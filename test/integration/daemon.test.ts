import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claim, emptyStore } from "../../src/claim-model";
import { save as saveClaims } from "../../src/claim-store-io";
import {
  beginLaunch,
  emptySessionSlots,
  markLaunchStarted,
  resolveLaunch,
  sessionsOn,
  slotsOn,
  unresolvedLaunches,
  hasLaunchRecordFor,
  restoreAttemptCount,
} from "../../src/session-slots";
import { save as saveSlots, load as loadSlots } from "../../src/session-slots-store";
import { initialDaemonState, runReconcileCycle, type DaemonDeps } from "../../src/daemon";
import type { ClaimKey } from "../../src/claim-key-resolve";
import type { RunCommandOptions, CommandResult } from "../../src/spawn";

const cleanupDirs: string[] = [];

afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bakr-daemon-test-"));
  cleanupDirs.push(dir);
  return dir;
}

function baseDeps(dir: string, runCommand: DaemonDeps["runCommand"]): DaemonDeps {
  let counter = 0;
  return {
    runCommand,
    claimsPath: join(dir, "claims.json"),
    sessionSlotsPath: join(dir, "session-slots.json"),
    now: () => 1_700_000_000_000,
    generateAttemptId: () => `attempt-${counter++}`,
  };
}

/** A fake `runCommand` that understands exactly the two invocation shapes this substrate makes, and simulates claude's own session-id-rotates-on-resume behaviour (measurement 4 in the ticket). */
function makeFakeClaude() {
  const listing: Array<{ id: string; sessionId: string; cwd: string; startedAt: number; kind: string }> = [];
  let nextShortId = 0;

  async function runCommand(argv: string[], _opts: RunCommandOptions): Promise<CommandResult> {
    if (argv[0] === "claude" && argv[1] === "agents") {
      return { exitCode: 0, stdout: JSON.stringify(listing), stderr: "" };
    }
    if (argv[0] === "systemd-run") {
      const bgIndex = argv.indexOf("--");
      const claudeArgs = argv.slice(bgIndex + 1); // ["claude", "--bg", ...maybe "--resume", id]
      const shortId = `short-${nextShortId++}`;
      const sessionId = `rotated-session-${shortId}`;
      const cwdFlagIndex = -1; // cwd travels via opts.cwd, not argv, per this substrate's own design
      void cwdFlagIndex;
      void claudeArgs;
      listing.push({ id: shortId, sessionId, cwd: _opts.cwd ?? "", startedAt: 1, kind: "background" });
      return { exitCode: 0, stdout: `backgrounded · ${shortId} (idle — send a prompt to start)\n`, stderr: "" };
    }
    throw new Error(`fake runCommand: unexpected argv ${JSON.stringify(argv)}`);
  }

  return { runCommand, listing };
}

describe("Constraint 3: a malformed claim store degrades the daemon", () => {
  test("no restore, no write, and the process never re-tries reading it as anything but degraded", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "claims.json"), "{ not json", "utf8");
    let calls = 0;
    const deps = baseDeps(dir, async () => {
      calls += 1;
      return { exitCode: 0, stdout: "[]", stderr: "" };
    });

    const result1 = await runReconcileCycle(initialDaemonState(), deps);
    expect(result1.claimDegraded).toBe(true);
    expect(result1.restored).toEqual([]);
    expect(calls).toBe(0); // never even lists — nothing claimed is known

    const result2 = await runReconcileCycle({ claimDegraded: result1.claimDegraded, sessionSlotsDegraded: result1.sessionSlotsDegraded }, deps);
    expect(result2.claimDegraded).toBe(true);
    expect(calls).toBe(0);
  });
});

describe("Constraint 3 applied to bakr's own session-slots store", () => {
  test("a malformed session-slots store also degrades: no restore, no write", async () => {
    const dir = await makeTempDir();
    const key = "/claimed/dir" as ClaimKey;
    await saveClaims(join(dir, "claims.json"), claim(emptyStore(), key, 1).state);
    await writeFile(join(dir, "session-slots.json"), "{ not json", "utf8");

    let calls = 0;
    const deps = baseDeps(dir, async () => {
      calls += 1;
      return { exitCode: 0, stdout: "[]", stderr: "" };
    });

    const result = await runReconcileCycle(initialDaemonState(), deps);
    expect(result.sessionSlotsDegraded).toBe(true);
    expect(result.restored).toEqual([]);
    expect(calls).toBe(0);
  });
});

describe("missing stores: a normal, empty first run", () => {
  test("no files on disk yet -> not degraded, nothing restored, listing still happens", async () => {
    const dir = await makeTempDir();
    let calls = 0;
    const deps = baseDeps(dir, async () => {
      calls += 1;
      return { exitCode: 0, stdout: "[]", stderr: "" };
    });

    const result = await runReconcileCycle(initialDaemonState(), deps);
    expect(result.claimDegraded).toBe(false);
    expect(result.sessionSlotsDegraded).toBe(false);
    expect(result.restored).toEqual([]);
    expect(calls).toBe(1); // one listing, even with nothing claimed
  });
});

describe("Constraint 1: a listing failure makes the whole cycle a no-op", () => {
  test("never treated as 'nothing running'; no restore is issued", async () => {
    const dir = await makeTempDir();
    const key = "/claimed/dir" as ClaimKey;
    await saveClaims(join(dir, "claims.json"), claim(emptyStore(), key, 1).state);
    let slots = emptySessionSlots();
    slots = beginLaunch(slots, key, undefined, "prior-attempt", 1);
    slots = markLaunchStarted(slots, "prior-attempt", "prior-short");
    slots = resolveLaunch(slots, "prior-short", "session-on-record");
    await saveSlots(join(dir, "session-slots.json"), slots);

    let launchCalls = 0;
    const deps = baseDeps(dir, async (argv) => {
      if (argv[0] === "systemd-run") launchCalls += 1;
      return { exitCode: 1, stdout: "", stderr: "not logged in" };
    });

    const result = await runReconcileCycle(initialDaemonState(), deps);
    expect(result.skippedListingFailed).toBe(true);
    expect(result.restored).toEqual([]);
    expect(launchCalls).toBe(0);

    // The on-record session id is untouched on disk — nothing was restored, nothing was written.
    const reloaded = await loadSlots(join(dir, "session-slots.json"));
    expect(reloaded.status).toBe("loaded");
    if (reloaded.status === "loaded") {
      expect(sessionsOn(reloaded.state, key)).toEqual(["session-on-record"]);
    }
  });
});

describe("the full silent-restore lifecycle", () => {
  test("an on-record session absent from a successful listing is restored via --resume of its DURABLE id, which never changes; only the live id updates once a listing reveals it (fixed after live review — see session-slots.ts's own module comment)", async () => {
    const dir = await makeTempDir();
    const key = "/claimed/dir" as ClaimKey;
    await saveClaims(join(dir, "claims.json"), claim(emptyStore(), key, 1).state);
    let slots = emptySessionSlots();
    slots = beginLaunch(slots, key, undefined, "prior-attempt", 1);
    slots = markLaunchStarted(slots, "prior-attempt", "prior-short");
    slots = resolveLaunch(slots, "prior-short", "old-session-id");
    await saveSlots(join(dir, "session-slots.json"), slots);

    const fake = makeFakeClaude();
    const deps = baseDeps(dir, fake.runCommand);

    // Cycle 1: the listing is empty (the session is not currently running) -> a restore is launched with --resume old-session-id.
    const result1 = await runReconcileCycle(initialDaemonState(), deps);
    expect(result1.restored).toEqual([{ key, sessionId: "old-session-id" }]);
    expect(fake.listing).toHaveLength(1);
    expect(fake.listing[0]?.cwd).toBe(key);

    const afterCycle1 = await loadSlots(join(dir, "session-slots.json"));
    expect(afterCycle1.status).toBe("loaded");
    if (afterCycle1.status === "loaded") {
      // Not yet resolved: onByKey still holds the OLD id until a listing confirms the new one.
      expect(sessionsOn(afterCycle1.state, key)).toEqual(["old-session-id"]);
    }

    // Cycle 2: the listing now includes the launched short id -> the pending launch resolves, learning the LIVE id. The durable id (what --resume takes) is UNCHANGED — this is the actual fix; before it, the durable id was overwritten with the rotated one, which the live review found could itself be unresumable. The rotated session has no pid yet (matches measurement 3), so it is "not-verifiable" and is correctly NOT restored again.
    const result2 = await runReconcileCycle({ claimDegraded: result1.claimDegraded, sessionSlotsDegraded: result1.sessionSlotsDegraded }, deps);
    expect(result2.restored).toEqual([]);
    expect(fake.listing).toHaveLength(1); // no second launch

    const afterCycle2 = await loadSlots(join(dir, "session-slots.json"));
    expect(afterCycle2.status).toBe("loaded");
    if (afterCycle2.status === "loaded") {
      // Durable id (what a future --resume would use) is untouched.
      expect(sessionsOn(afterCycle2.state, key)).toEqual(["old-session-id"]);
      // But the live id used for liveness checks now reflects the listing.
      expect(slotsOn(afterCycle2.state, key)).toEqual([{ durableSessionId: "old-session-id", liveSessionId: fake.listing[0]!.sessionId }]);
    }
  });

  test("a session already alive (listed with a verifiably-alive pid) is never restored", async () => {
    const dir = await makeTempDir();
    const key = "/claimed/dir" as ClaimKey;
    await saveClaims(join(dir, "claims.json"), claim(emptyStore(), key, 1).state);
    let slots = emptySessionSlots();
    slots = beginLaunch(slots, key, undefined, "prior-attempt", 1);
    slots = markLaunchStarted(slots, "prior-attempt", "prior-short");
    slots = resolveLaunch(slots, "prior-short", "live-session-id");
    await saveSlots(join(dir, "session-slots.json"), slots);

    let launchCalls = 0;
    const deps = baseDeps(dir, async (argv) => {
      if (argv[0] === "systemd-run") {
        launchCalls += 1;
        return { exitCode: 0, stdout: "backgrounded · short-x (idle)\n", stderr: "" };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify([{ id: "short-live", sessionId: "live-session-id", cwd: key, startedAt: 1, kind: "background", pid: process.pid }]),
        stderr: "",
      };
    });

    const result = await runReconcileCycle(initialDaemonState(), deps);
    expect(result.restored).toEqual([]);
    expect(launchCalls).toBe(0);
  });
});

describe("regression (BAKR-12 PR #9 review): the daemon must always resume the DURABLE id, never a rotated live id that may itself be unresumable", () => {
  test("reproduces the live incident: resuming the ROTATED id fails ('No conversation found'), resuming the ORIGINAL durable id keeps succeeding — the daemon must always pass the durable id to --resume, across every restore cycle", async () => {
    const dir = await makeTempDir();
    const key = "/claimed/dir" as ClaimKey;
    await saveClaims(join(dir, "claims.json"), claim(emptyStore(), key, 1).state);
    const DURABLE_ID = "03df9926-durable-conversation";
    let slots = emptySessionSlots();
    slots = beginLaunch(slots, key, undefined, "seed-attempt", 1);
    slots = markLaunchStarted(slots, "seed-attempt", "seed-short");
    slots = resolveLaunch(slots, "seed-short", DURABLE_ID);
    await saveSlots(join(dir, "session-slots.json"), slots);

    // Models the reviewer's exact live trace: --resume <DURABLE_ID> always
    // succeeds and rotates to a fresh live id; --resume of anything ELSE
    // (i.e. a rotated id, if the daemon mistakenly tried to resume one)
    // fails outright, exactly like their observed
    // "exit 1 before init — No conversation found" job state. The rotated
    // session never sticks around in the listing (as in the earlier
    // convergence-bound test), so every cycle looks like "absent" and
    // triggers another restore attempt.
    const launchArgvs: string[][] = [];
    let rotationCounter = 0;
    let pendingEntry: { id: string; sessionId: string } | undefined;
    const runCommand = async (argv: string[]) => {
      if (argv[0] === "claude" && argv[1] === "agents") {
        const listing = pendingEntry
          ? [{ id: pendingEntry.id, sessionId: pendingEntry.sessionId, cwd: key, startedAt: 1, kind: "background" }]
          : [];
        pendingEntry = undefined;
        return { exitCode: 0, stdout: JSON.stringify(listing), stderr: "" };
      }
      if (argv[0] === "systemd-run") {
        launchArgvs.push(argv);
        const resumeIdx = argv.indexOf("--resume");
        const resumedId = resumeIdx === -1 ? undefined : argv[resumeIdx + 1];
        if (resumedId !== DURABLE_ID) {
          // The exact failure the reviewer observed when the daemon (pre-fix) resumed a rotated id instead of the durable one.
          return { exitCode: 1, stdout: "", stderr: `exit 1 before init — No conversation found with session ID: ${resumedId}` };
        }
        rotationCounter += 1;
        const shortId = `short-${rotationCounter}`;
        const rotatedId = `rotated-${rotationCounter}`;
        pendingEntry = { id: shortId, sessionId: rotatedId };
        return { exitCode: 0, stdout: `backgrounded · ${shortId} (idle — send a prompt to start)\n`, stderr: "" };
      }
      throw new Error(`unexpected argv: ${JSON.stringify(argv)}`);
    };

    const deps = baseDeps(dir, runCommand);
    let state = initialDaemonState();
    for (let i = 0; i < 8; i++) {
      const result = await runReconcileCycle(state, deps);
      state = { claimDegraded: result.claimDegraded, sessionSlotsDegraded: result.sessionSlotsDegraded };
    }

    // Every single launch attempt resumed the DURABLE id — never a rotated one.
    expect(launchArgvs.length).toBeGreaterThan(0);
    for (const argv of launchArgvs) {
      const resumeIdx = argv.indexOf("--resume");
      expect(argv[resumeIdx + 1]).toBe(DURABLE_ID);
    }

    // The durable id on record is still exactly the original — never overwritten with a rotated (and here, unresumable-if-tried) id.
    const finalState = await loadSlots(join(dir, "session-slots.json"));
    expect(finalState.status).toBe("loaded");
    if (finalState.status === "loaded") {
      expect(sessionsOn(finalState.state, key)).toEqual([DURABLE_ID]);
    }
  });
});

describe("regression (PR #7 review round 3): a resume that 'succeeds' but is actually a silent empty session (measurement 5) must not loop forever", () => {
  test("reproduces the live incident: every resume exits 0 but is a phantom session with no pid that vanishes by the next listing — the daemon must converge, not spawn unboundedly", async () => {
    const dir = await makeTempDir();
    const key = "/claimed/dir" as ClaimKey;
    await saveClaims(join(dir, "claims.json"), claim(emptyStore(), key, 1).state);
    let slots = emptySessionSlots();
    slots = beginLaunch(slots, key, undefined, "seed-attempt", 1);
    slots = markLaunchStarted(slots, "seed-attempt", "seed-short");
    slots = resolveLaunch(slots, "seed-short", "seed-session-id");
    await saveSlots(join(dir, "session-slots.json"), slots);

    // Models the exact failure mode from the live incident: `launch()`
    // always reports ok:true (exit 0, ordinary `backgrounded · <id>` line —
    // claude's own CLI is silent about the underlying resume having
    // failed, per the ticket's measurement 5), but the resulting session
    // has no pid, and — critically — it is gone from the listing entirely
    // by the NEXT cycle, exactly like the reviewer's own live trace, which
    // is what makes each cycle look like "genuinely absent" (verdict
    // "unknown") rather than merely "not yet verified" (verdict
    // "not-verifiable"), and is why `hasLaunchRecordFor` alone cannot stop
    // it: the session id is different every time.
    let launchCalls = 0;
    let pendingEntry: { id: string; sessionId: string } | undefined;
    const runCommand = async (argv: string[]) => {
      if (argv[0] === "claude" && argv[1] === "agents") {
        const listing = pendingEntry
          ? [{ id: pendingEntry.id, sessionId: pendingEntry.sessionId, cwd: key, startedAt: 1, kind: "background" }]
          : [];
        pendingEntry = undefined; // vanishes after being listed exactly once, unverified
        return { exitCode: 0, stdout: JSON.stringify(listing), stderr: "" };
      }
      if (argv[0] === "systemd-run") {
        launchCalls += 1;
        const shortId = `short-${launchCalls}`;
        const sessionId = `phantom-session-${shortId}`;
        pendingEntry = { id: shortId, sessionId };
        return { exitCode: 0, stdout: `backgrounded · ${shortId} (idle — send a prompt to start)\n`, stderr: "" };
      }
      throw new Error(`unexpected argv: ${JSON.stringify(argv)}`);
    };

    const deps = baseDeps(dir, runCommand);

    // Run well past where the pre-fix code would still be looping (10
    // cycles; the bound must have kicked in long before this).
    let state = initialDaemonState();
    for (let i = 0; i < 10; i++) {
      const result = await runReconcileCycle(state, deps);
      state = { claimDegraded: result.claimDegraded, sessionSlotsDegraded: result.sessionSlotsDegraded };
    }

    // Convergence: launch() was called a bounded number of times, not once per cycle.
    expect(launchCalls).toBeLessThanOrEqual(3);
    expect(launchCalls).toBeGreaterThan(0); // it did genuinely try — this isn't a test that passes by accident

    // The daemon gave up honestly: the slot is now permanently unresolved and logged, never silently dropped.
    const finalState = await loadSlots(join(dir, "session-slots.json"));
    expect(finalState.status).toBe("loaded");
    if (finalState.status === "loaded") {
      expect(unresolvedLaunches(finalState.state).length).toBeGreaterThan(0);
    }

    // Run several MORE cycles and confirm it truly stays converged — not merely slow.
    const launchCallsAtConvergence = launchCalls;
    for (let i = 0; i < 5; i++) {
      const result = await runReconcileCycle(state, deps);
      state = { claimDegraded: result.claimDegraded, sessionSlotsDegraded: result.sessionSlotsDegraded };
    }
    expect(launchCalls).toBe(launchCallsAtConvergence);
  });

  test("a genuinely successful restore (verified alive) resets the count, so a LATER, unrelated failure gets the full retry budget again", async () => {
    const dir = await makeTempDir();
    const key = "/claimed/dir" as ClaimKey;
    await saveClaims(join(dir, "claims.json"), claim(emptyStore(), key, 1).state);
    let slots = emptySessionSlots();
    slots = beginLaunch(slots, key, undefined, "seed-attempt", 1);
    slots = markLaunchStarted(slots, "seed-attempt", "seed-short");
    slots = resolveLaunch(slots, "seed-short", "seed-session-id");
    await saveSlots(join(dir, "session-slots.json"), slots);

    // Cycle 1: restore "seed-session-id" -> a REAL, verifiable success (has our own, genuinely-alive pid).
    let phase = 1;
    let launchCalls = 0;
    const runCommand = async (argv: string[]) => {
      if (argv[0] === "claude" && argv[1] === "agents") {
        if (phase === 1) {
          return { exitCode: 0, stdout: "[]", stderr: "" };
        }
        if (phase === 2) {
          return {
            exitCode: 0,
            stdout: JSON.stringify([{ id: "real-short", sessionId: "real-session-id", cwd: key, startedAt: 1, kind: "background", pid: process.pid }]),
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "[]", stderr: "" }; // phase 3+: it "dies" for real, starting a fresh failure saga
      }
      if (argv[0] === "systemd-run") {
        launchCalls += 1;
        if (phase === 1) return { exitCode: 0, stdout: "backgrounded · real-short (idle)\n", stderr: "" };
        return { exitCode: 0, stdout: `backgrounded · new-short-${launchCalls} (idle)\n`, stderr: "" };
      }
      throw new Error("unexpected argv");
    };

    const deps = baseDeps(dir, runCommand);
    let state = initialDaemonState();

    await runReconcileCycle(state, deps); // issues the restore
    phase = 2;
    const r2 = await runReconcileCycle(state, deps); // resolves it AND verifies it alive (real pid) in the same cycle
    state = { claimDegraded: r2.claimDegraded, sessionSlotsDegraded: r2.sessionSlotsDegraded };

    const afterSuccess = await loadSlots(join(dir, "session-slots.json"));
    expect(afterSuccess.status).toBe("loaded");
    if (afterSuccess.status === "loaded") {
      expect(restoreAttemptCount(afterSuccess.state, key)).toBe(0); // reset after verified-alive
    }

    // Now it genuinely goes down and starts failing again — must get the FULL budget, not an already-exhausted one.
    phase = 3;
    const launchCallsBeforeSecondSaga = launchCalls;
    for (let i = 0; i < 10; i++) {
      const r = await runReconcileCycle(state, deps);
      state = { claimDegraded: r.claimDegraded, sessionSlotsDegraded: r.sessionSlotsDegraded };
    }
    // In this scenario every "restore" resolves to a listed-but-unverified session that never disappears (still listed, just no pid) -> not-verifiable, not unknown -> never even reaches the bound, only one launch. This asserts the budget was available at all (not pre-exhausted from before the reset), not the bound's own convergence (covered above).
    expect(launchCalls).toBe(launchCallsBeforeSecondSaga + 1);
  });
});

describe("regression (PR #7 review): a crash mid-launch must not silently wedge a session's restore forever", () => {
  test("a record left with no launchShortId and no error (the exact on-disk shape for the whole duration of launch()) is recovered, logged, and never silently blocks restore going forward", async () => {
    const dir = await makeTempDir();
    const key = "/claimed/dir" as ClaimKey;
    await saveClaims(join(dir, "claims.json"), claim(emptyStore(), key, 1).state);

    // Simulate the exact crash window the review demonstrated: beginLaunch's
    // own saveSlots already happened, but the process ended before
    // launch() returned — so markLaunchStarted/markLaunchFailed never ran.
    let slots = emptySessionSlots();
    slots = beginLaunch(slots, key, "stale-prior-session", "wedged-attempt", 1000);
    expect(hasLaunchRecordFor(slots, key, "stale-prior-session")).toBe(true);
    await saveSlots(join(dir, "session-slots.json"), slots);

    // Before the fix, sessionsOn was empty here too, so there's nothing to
    // "restore" via the normal path in this exact scenario — the bug is
    // that the record is invisible to BOTH pendingLaunches (no shortId to
    // resolve) and unresolvedLaunches (no error yet) on the very next load.
    const reloadedBefore = await loadSlots(join(dir, "session-slots.json"));
    expect(reloadedBefore.status).toBe("loaded");
    if (reloadedBefore.status === "loaded") {
      expect(unresolvedLaunches(reloadedBefore.state)).toHaveLength(0); // not yet logged anywhere — this is the wedge
    }

    let launchCalls = 0;
    const deps = baseDeps(dir, async (argv) => {
      if (argv[0] === "systemd-run") launchCalls += 1;
      return { exitCode: 0, stdout: "[]", stderr: "" };
    });

    const result = await runReconcileCycle(initialDaemonState(), deps);

    // The record must now be reported (Constraint 2's every-cycle error
    // log) rather than silently invisible, and must never be retried
    // automatically.
    const reloadedAfter = await loadSlots(join(dir, "session-slots.json"));
    expect(reloadedAfter.status).toBe("loaded");
    if (reloadedAfter.status === "loaded") {
      expect(unresolvedLaunches(reloadedAfter.state)).toHaveLength(1);
      expect(unresolvedLaunches(reloadedAfter.state)[0]?.error).toMatch(/ended before this launch's outcome was recorded/);
    }
    expect(launchCalls).toBe(0); // never auto-retried
    expect(result.restored).toEqual([]);

    // And it stays reported, cycle after cycle — never silently re-swallowed.
    const result2 = await runReconcileCycle({ claimDegraded: result.claimDegraded, sessionSlotsDegraded: result.sessionSlotsDegraded }, deps);
    expect(result2.restored).toEqual([]);
    expect(launchCalls).toBe(0);
    const reloadedStill = await loadSlots(join(dir, "session-slots.json"));
    if (reloadedStill.status === "loaded") {
      expect(unresolvedLaunches(reloadedStill.state)).toHaveLength(1);
    }
  });
});

describe("Constraint 2: a failed restore launch is recorded, never retried automatically", () => {
  test("across repeated cycles, the failed launch is logged but launch() is called exactly once", async () => {
    const dir = await makeTempDir();
    const key = "/claimed/dir" as ClaimKey;
    await saveClaims(join(dir, "claims.json"), claim(emptyStore(), key, 1).state);
    let slots = emptySessionSlots();
    slots = beginLaunch(slots, key, undefined, "prior-attempt", 1);
    slots = markLaunchStarted(slots, "prior-attempt", "prior-short");
    slots = resolveLaunch(slots, "prior-short", "old-session-id");
    await saveSlots(join(dir, "session-slots.json"), slots);

    let launchCalls = 0;
    const deps = baseDeps(dir, async (argv) => {
      if (argv[0] === "systemd-run") {
        launchCalls += 1;
        return { exitCode: 1, stdout: "", stderr: "systemd-run: permission denied" };
      }
      return { exitCode: 0, stdout: "[]", stderr: "" };
    });

    const result1 = await runReconcileCycle(initialDaemonState(), deps);
    expect(result1.restored).toEqual([]);
    expect(launchCalls).toBe(1);

    const afterCycle1 = await loadSlots(join(dir, "session-slots.json"));
    expect(afterCycle1.status).toBe("loaded");
    if (afterCycle1.status === "loaded") {
      // The stale id is still on record — a failed launch never removes it, and this is what the guard below checks against.
      expect(sessionsOn(afterCycle1.state, key)).toEqual(["old-session-id"]);
    }

    const result2 = await runReconcileCycle({ claimDegraded: result1.claimDegraded, sessionSlotsDegraded: result1.sessionSlotsDegraded }, deps);
    expect(result2.restored).toEqual([]);
    expect(launchCalls).toBe(1); // still 1 — never retried automatically (Constraint 2)

    const result3 = await runReconcileCycle({ claimDegraded: result2.claimDegraded, sessionSlotsDegraded: result2.sessionSlotsDegraded }, deps);
    expect(launchCalls).toBe(1);
    expect(result3.restored).toEqual([]);
  });
});
