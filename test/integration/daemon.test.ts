import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claim, emptyStore } from "../../src/claim-model";
import { save as saveClaims } from "../../src/claim-store-io";
import { beginLaunch, emptySessionSlots, markLaunchStarted, resolveLaunch, sessionsOn, unresolvedLaunches, hasLaunchRecordFor } from "../../src/session-slots";
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
  test("an on-record session absent from a successful listing is restored via --resume, then its rotated session id is learned and recorded on the next cycle", async () => {
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

    // Cycle 2: the listing now includes the launched short id -> the pending launch resolves, replacing the old id with the rotated one. The rotated session has no pid yet (matches measurement 3), so it is "not-verifiable" and is correctly NOT restored again.
    const result2 = await runReconcileCycle({ claimDegraded: result1.claimDegraded, sessionSlotsDegraded: result1.sessionSlotsDegraded }, deps);
    expect(result2.restored).toEqual([]);
    expect(fake.listing).toHaveLength(1); // no second launch

    const afterCycle2 = await loadSlots(join(dir, "session-slots.json"));
    expect(afterCycle2.status).toBe("loaded");
    if (afterCycle2.status === "loaded") {
      expect(sessionsOn(afterCycle2.state, key)).toEqual([fake.listing[0]!.sessionId]);
      expect(sessionsOn(afterCycle2.state, key)).not.toContain("old-session-id");
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
