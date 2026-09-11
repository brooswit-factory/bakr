import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claim, emptyStore } from "../../src/claim-model";
import { realOrphanProbeDeps } from "../../src/paths";
import { save as saveClaims } from "../../src/claim-store-io";
import { emptySessionSlots, beginLaunch, markLaunchStarted, resolveLaunch, markLaunchFailed, serializeSessionSlotsState } from "../../src/session-slots";
import { save as saveAgents, load as loadAgents } from "../../src/agent-store-io";
import { emptyAgentStore, putAgent, unresolvedLaunches, type AgentRecord } from "../../src/agent-model";
import { initialDaemonState, runReconcileCycle, type DaemonDeps } from "../../src/daemon";
import type { ClaimKey } from "../../src/claim-key-resolve";
import type { RunCommandOptions, CommandResult } from "../../src/spawn";
import type { OrphanProbeDeps } from "../../src/orphan-probe";

/** These tests use symbolic paths like "/claimed/dir" that do not exist on the real filesystem — a real `stat` would classify every one of them as orphaned. This fake always reports "exists", preserving the pre-BAKR-24 behaviour (every claimed directory is `present`) for every test that isn't specifically exercising Q4's orphan-reporting behaviour (see the dedicated "BAKR-24" describe block below, which builds its own real-directory fixtures instead). */
export const alwaysPresentProbeDeps: OrphanProbeDeps = { stat: async () => ({ dev: 1, ino: 1, isDirectory: () => true }) };

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
  let randomCounter = 0;
  return {
    runCommand,
    claimsPath: join(dir, "claims.json"),
    agentsPath: join(dir, "agents.json"),
    sessionSlotsPath: join(dir, "session-slots.json"),
    now: () => 1_700_000_000_000,
    generateAttemptId: () => `attempt-${counter++}`,
    randomBytes: (n: number) => {
      randomCounter += 1;
      return new Uint8Array(n).fill(randomCounter & 0xff);
    },
    probeDeps: alwaysPresentProbeDeps,
  };
}

function makeAgent(overrides: Partial<AgentRecord> & { id: string; directory: ClaimKey }): AgentRecord {
  return { name: undefined, state: "on", createdAt: 1, durableSessionId: undefined, liveSessionId: undefined, ...overrides };
}

/** A fake `runCommand` that understands the two invocation shapes this substrate makes, and simulates claude's session-id-rotates-on-resume behaviour. THROWS on any `claude stop` invocation — arming the AC3 falsifier ("fail loudly if the loop ever issues a stop") across every test that uses it. */
function makeFakeClaude() {
  const listing: Array<{ id: string; sessionId: string; cwd: string; startedAt: number; kind: string; pid?: number }> = [];
  let nextShortId = 0;

  async function runCommand(argv: string[], opts: RunCommandOptions): Promise<CommandResult> {
    if (argv[0] === "claude" && argv[1] === "agents") {
      return { exitCode: 0, stdout: JSON.stringify(listing), stderr: "" };
    }
    if (argv[0] === "claude" && argv[1] === "stop") {
      throw new Error(`FALSIFIER TRIPPED: this loop must never issue a stop (B7) — got: ${JSON.stringify(argv)}`);
    }
    if (argv[0] === "systemd-run") {
      const shortId = `short-${nextShortId++}`;
      const sessionId = `rotated-session-${shortId}`;
      listing.push({ id: shortId, sessionId, cwd: opts.cwd ?? "", startedAt: 1, kind: "background" });
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
    expect(calls).toBe(0);

    const result2 = await runReconcileCycle({ claimDegraded: result1.claimDegraded, agentsDegraded: result1.agentsDegraded, orphanReportSignatures: result1.orphanReportSignatures }, deps);
    expect(result2.claimDegraded).toBe(true);
    expect(calls).toBe(0);
  });
});

describe("AC6/AC13: a malformed agents.json degrades the daemon and is NEVER treated as absent", () => {
  test("no restore, no write to agents.json, and session-slots.json is NEVER read as a fallback (R-A.1)", async () => {
    const dir = await makeTempDir();
    const key = "/claimed/dir" as ClaimKey;
    await saveClaims(join(dir, "claims.json"), claim(emptyStore(), key, 1).state);
    await writeFile(join(dir, "agents.json"), "{ not json at all", "utf8");
    // A perfectly valid session-slots.json sits right beside it — falsifier: any agent restored from it, or any write derived from it.
    let slots = emptySessionSlots();
    slots = beginLaunch(slots, key, undefined, "seed", 1);
    slots = markLaunchStarted(slots, "seed", "seed-short");
    slots = resolveLaunch(slots, "seed-short", "durable-should-never-be-touched");
    await writeFile(join(dir, "session-slots.json"), serializeSessionSlotsState(slots), "utf8");

    let calls = 0;
    const deps = baseDeps(dir, async () => {
      calls += 1;
      return { exitCode: 0, stdout: "[]", stderr: "" };
    });

    const result = await runReconcileCycle(initialDaemonState(), deps);
    expect(result.agentsDegraded).toBe(true);
    expect(result.restored).toEqual([]);
    expect(calls).toBe(0); // never even lists — degraded before the listing step

    // agents.json is byte-for-byte unchanged — never migrated into, never overwritten.
    const raw = await Bun.file(join(dir, "agents.json")).text();
    expect(raw).toBe("{ not json at all");
  });

  test("NEGATIVE CONTROL: the identical setup, but agents.json is genuinely ABSENT, DOES migrate — proving the check above is 'correctly refused', not 'never reads that file at all'", async () => {
    const dir = await makeTempDir();
    const key = "/claimed/dir" as ClaimKey;
    await saveClaims(join(dir, "claims.json"), claim(emptyStore(), key, 1).state);
    let slots = emptySessionSlots();
    slots = beginLaunch(slots, key, undefined, "seed", 1);
    slots = markLaunchStarted(slots, "seed", "seed-short");
    slots = resolveLaunch(slots, "seed-short", "durable-1");
    await writeFile(join(dir, "session-slots.json"), serializeSessionSlotsState(slots), "utf8");
    // agents.json does NOT exist.

    const fake = makeFakeClaude();
    const deps = baseDeps(dir, fake.runCommand);
    const result = await runReconcileCycle(initialDaemonState(), deps);
    expect(result.agentsDegraded).toBe(false);
    expect(result.restored).toHaveLength(1); // the migrated agent WAS restored
    const loaded = await loadAgents(join(dir, "agents.json"));
    expect(loaded.status).toBe("loaded");
    if (loaded.status === "loaded") expect(Object.keys(loaded.state.agents)).toHaveLength(1);
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
    expect(result.agentsDegraded).toBe(false);
    expect(result.restored).toEqual([]);
    expect(calls).toBe(1);
  });
});

describe("Constraint 1: a listing failure makes the whole cycle a no-op", () => {
  test("never treated as 'nothing running'; no restore is issued", async () => {
    const dir = await makeTempDir();
    const key = "/claimed/dir" as ClaimKey;
    await saveClaims(join(dir, "claims.json"), claim(emptyStore(), key, 1).state);
    await saveAgents(join(dir, "agents.json"), putAgent(emptyAgentStore(), makeAgent({ id: "@a1", directory: key, durableSessionId: "session-on-record", liveSessionId: "session-on-record" })));

    let launchCalls = 0;
    const deps = baseDeps(dir, async (argv) => {
      if (argv[0] === "systemd-run") launchCalls += 1;
      return { exitCode: 1, stdout: "", stderr: "not logged in" };
    });

    const result = await runReconcileCycle(initialDaemonState(), deps);
    expect(result.skippedListingFailed).toBe(true);
    expect(result.restored).toEqual([]);
    expect(launchCalls).toBe(0);

    const reloaded = await loadAgents(join(dir, "agents.json"));
    expect(reloaded.status).toBe("loaded");
    if (reloaded.status === "loaded") expect(reloaded.state.agents["@a1"]?.durableSessionId).toBe("session-on-record");
  });
});

describe("AC2: restore is silent and exact — the recorded launch argv carries EXACTLY --resume <durableSessionId>", () => {
  test("through the real reconcile cycle against a migrated store (stubbed claude — proves what bakr constructs and passes, nothing about the real binary)", async () => {
    const dir = await makeTempDir();
    const key = "/claimed/dir" as ClaimKey;
    await saveClaims(join(dir, "claims.json"), claim(emptyStore(), key, 1).state);
    let slots = emptySessionSlots();
    slots = beginLaunch(slots, key, undefined, "seed", 1);
    slots = markLaunchStarted(slots, "seed", "seed-short");
    slots = resolveLaunch(slots, "seed-short", "old-session-id");
    await writeFile(join(dir, "session-slots.json"), serializeSessionSlotsState(slots), "utf8");

    const launchArgvs: string[][] = [];
    const deps = baseDeps(dir, async (argv, opts) => {
      if (argv[0] === "claude" && argv[1] === "agents") return { exitCode: 0, stdout: "[]", stderr: "" };
      if (argv[0] === "systemd-run") {
        launchArgvs.push(argv);
        const bgIndex = argv.indexOf("--");
        void opts;
        return { exitCode: 0, stdout: "backgrounded · short-1 (idle — send a prompt to start)\n", stderr: "" };
      }
      throw new Error(`unexpected argv: ${JSON.stringify(argv)}`);
    });

    const result = await runReconcileCycle(initialDaemonState(), deps);
    expect(result.restored).toHaveLength(1);
    expect(launchArgvs).toHaveLength(1);
    const argv = launchArgvs[0] as string[];
    const bgIndex = argv.indexOf("--");
    const claudeArgs = argv.slice(bgIndex + 1);
    expect(claudeArgs).toEqual(["claude", "--bg", "--resume", "old-session-id"]); // EXACTLY this and nothing else
  });
});

describe("AC3: only 'on' is restored — off and archived are NEVER launched, with the negative control that 'on' IS", () => {
  test("one directory holding on/off/archived agents, across several cycles", async () => {
    const dir = await makeTempDir();
    const key = "/claimed/dir" as ClaimKey;
    await saveClaims(join(dir, "claims.json"), claim(emptyStore(), key, 1).state);
    let store = emptyAgentStore();
    store = putAgent(store, makeAgent({ id: "@on-agent", directory: key, state: "on" }));
    store = putAgent(store, makeAgent({ id: "@off-agent", directory: key, state: "off" }));
    store = putAgent(store, makeAgent({ id: "@archived-agent", directory: key, state: "archived" }));
    await saveAgents(join(dir, "agents.json"), store);

    const fake = makeFakeClaude(); // throws if a `claude stop` is ever issued
    const deps = baseDeps(dir, fake.runCommand);

    let state = initialDaemonState();
    for (let i = 0; i < 3; i++) {
      const result = await runReconcileCycle(state, deps);
      state = { claimDegraded: result.claimDegraded, agentsDegraded: result.agentsDegraded, orphanReportSignatures: result.orphanReportSignatures };
    }

    const final = await loadAgents(join(dir, "agents.json"));
    expect(final.status).toBe("loaded");
    if (final.status === "loaded") {
      expect(final.state.agents["@off-agent"]?.durableSessionId).toBeUndefined();
      expect(final.state.agents["@archived-agent"]?.durableSessionId).toBeUndefined();
      // NEGATIVE CONTROL: the on-agent DID get launched — proves the run can observe a launch at all.
      expect(final.state.agents["@on-agent"]?.durableSessionId).toBeDefined();
    }
  });
});

describe("AC4 (HEADLINE): fresh-launch resolution by agent, not directory", () => {
  test("two agents launched fresh into the SAME directory in the SAME cycle each end up holding their own session", async () => {
    const dir = await makeTempDir();
    const key = "/claimed/dir" as ClaimKey;
    await saveClaims(join(dir, "claims.json"), claim(emptyStore(), key, 1).state);
    let store = emptyAgentStore();
    store = putAgent(store, makeAgent({ id: "@agent-1", directory: key, state: "on", durableSessionId: undefined }));
    store = putAgent(store, makeAgent({ id: "@agent-2", directory: key, state: "on", durableSessionId: undefined }));
    await saveAgents(join(dir, "agents.json"), store);

    const fake = makeFakeClaude();
    const deps = baseDeps(dir, fake.runCommand);

    // Cycle 1: both fresh launches issued.
    const result1 = await runReconcileCycle(initialDaemonState(), deps);
    expect(result1.restored).toHaveLength(2);
    expect(new Set(result1.restored.map((r) => r.agentId))).toEqual(new Set(["@agent-1", "@agent-2"]));

    // Cycle 2: the listing now includes both launched short ids -> both resolve, EACH to its own agent.
    const result2 = await runReconcileCycle({ claimDegraded: result1.claimDegraded, agentsDegraded: result1.agentsDegraded, orphanReportSignatures: result1.orphanReportSignatures }, deps);
    void result2;

    const final = await loadAgents(join(dir, "agents.json"));
    expect(final.status).toBe("loaded");
    if (final.status === "loaded") {
      const a1 = final.state.agents["@agent-1"];
      const a2 = final.state.agents["@agent-2"];
      expect(a1?.durableSessionId).toBeDefined();
      expect(a2?.durableSessionId).toBeDefined();
      expect(a1?.durableSessionId).not.toBe(a2?.durableSessionId); // distinct sessions, correctly attributed
    }
  });
});

describe("the full silent-restore lifecycle (durable id never overwritten)", () => {
  test("an on-record session absent from a successful listing is restored via --resume of its DURABLE id; only the live id updates once a listing reveals it", async () => {
    const dir = await makeTempDir();
    const key = "/claimed/dir" as ClaimKey;
    await saveClaims(join(dir, "claims.json"), claim(emptyStore(), key, 1).state);
    await saveAgents(join(dir, "agents.json"), putAgent(emptyAgentStore(), makeAgent({ id: "@a1", directory: key, durableSessionId: "old-session-id", liveSessionId: "old-session-id" })));

    const fake = makeFakeClaude();
    const deps = baseDeps(dir, fake.runCommand);

    const result1 = await runReconcileCycle(initialDaemonState(), deps);
    expect(result1.restored).toEqual([{ agentId: "@a1", key, sessionId: "old-session-id" }]);

    const afterCycle1 = await loadAgents(join(dir, "agents.json"));
    if (afterCycle1.status === "loaded") expect(afterCycle1.state.agents["@a1"]?.durableSessionId).toBe("old-session-id");

    const result2 = await runReconcileCycle({ claimDegraded: result1.claimDegraded, agentsDegraded: result1.agentsDegraded, orphanReportSignatures: result1.orphanReportSignatures }, deps);
    expect(result2.restored).toEqual([]); // resolved, not restored again

    const afterCycle2 = await loadAgents(join(dir, "agents.json"));
    expect(afterCycle2.status).toBe("loaded");
    if (afterCycle2.status === "loaded") {
      const agent = afterCycle2.state.agents["@a1"];
      expect(agent?.durableSessionId).toBe("old-session-id"); // UNCHANGED
      expect(agent?.liveSessionId).toBe(fake.listing[0]?.sessionId); // updated to the rotated id
    }
  });

  test("a session already alive (listed with a verifiably-alive pid) is never restored", async () => {
    const dir = await makeTempDir();
    const key = "/claimed/dir" as ClaimKey;
    await saveClaims(join(dir, "claims.json"), claim(emptyStore(), key, 1).state);
    await saveAgents(join(dir, "agents.json"), putAgent(emptyAgentStore(), makeAgent({ id: "@a1", directory: key, durableSessionId: "live-session-id", liveSessionId: "live-session-id" })));

    let launchCalls = 0;
    const deps = baseDeps(dir, async (argv) => {
      if (argv[0] === "systemd-run") {
        launchCalls += 1;
        return { exitCode: 0, stdout: "backgrounded · short-x (idle)\n", stderr: "" };
      }
      return { exitCode: 0, stdout: JSON.stringify([{ id: "short-live", sessionId: "live-session-id", cwd: key, startedAt: 1, kind: "background", pid: process.pid }]), stderr: "" };
    });

    const result = await runReconcileCycle(initialDaemonState(), deps);
    expect(result.restored).toEqual([]);
    expect(launchCalls).toBe(0);
  });
});

describe("regression: the daemon must always resume the DURABLE id, never a rotated live id that may itself be unresumable", () => {
  test("resuming the ROTATED id fails, resuming the ORIGINAL durable id keeps succeeding — every restore attempt across many cycles uses the durable id", async () => {
    const dir = await makeTempDir();
    const key = "/claimed/dir" as ClaimKey;
    await saveClaims(join(dir, "claims.json"), claim(emptyStore(), key, 1).state);
    const DURABLE_ID = "03df9926-durable-conversation";
    await saveAgents(join(dir, "agents.json"), putAgent(emptyAgentStore(), makeAgent({ id: "@a1", directory: key, durableSessionId: DURABLE_ID, liveSessionId: DURABLE_ID })));

    const launchArgvs: string[][] = [];
    let rotationCounter = 0;
    let pendingEntry: { id: string; sessionId: string } | undefined;
    const runCommand = async (argv: string[]) => {
      if (argv[0] === "claude" && argv[1] === "agents") {
        const listing = pendingEntry ? [{ id: pendingEntry.id, sessionId: pendingEntry.sessionId, cwd: key, startedAt: 1, kind: "background" }] : [];
        pendingEntry = undefined;
        return { exitCode: 0, stdout: JSON.stringify(listing), stderr: "" };
      }
      if (argv[0] === "systemd-run") {
        launchArgvs.push(argv);
        const resumeIdx = argv.indexOf("--resume");
        const resumedId = resumeIdx === -1 ? undefined : argv[resumeIdx + 1];
        if (resumedId !== DURABLE_ID) {
          return { exitCode: 1, stdout: "", stderr: `exit 1 before init — No conversation found with session ID: ${resumedId}` };
        }
        rotationCounter += 1;
        const shortId = `short-${rotationCounter}`;
        pendingEntry = { id: shortId, sessionId: `rotated-${rotationCounter}` };
        return { exitCode: 0, stdout: `backgrounded · ${shortId} (idle — send a prompt to start)\n`, stderr: "" };
      }
      throw new Error(`unexpected argv: ${JSON.stringify(argv)}`);
    };

    const deps = baseDeps(dir, runCommand);
    let state = initialDaemonState();
    for (let i = 0; i < 8; i++) {
      const result = await runReconcileCycle(state, deps);
      state = { claimDegraded: result.claimDegraded, agentsDegraded: result.agentsDegraded, orphanReportSignatures: result.orphanReportSignatures };
    }

    expect(launchArgvs.length).toBeGreaterThan(0);
    for (const argv of launchArgvs) {
      const resumeIdx = argv.indexOf("--resume");
      expect(argv[resumeIdx + 1]).toBe(DURABLE_ID);
    }

    const finalState = await loadAgents(join(dir, "agents.json"));
    expect(finalState.status).toBe("loaded");
    if (finalState.status === "loaded") expect(finalState.state.agents["@a1"]?.durableSessionId).toBe(DURABLE_ID);
  });
});

describe("regression: a resume that 'succeeds' but is actually a silent empty session must not loop forever (convergence)", () => {
  test("every resume exits 0 but is a phantom session with no pid that vanishes by the next listing — the daemon must converge", async () => {
    const dir = await makeTempDir();
    const key = "/claimed/dir" as ClaimKey;
    await saveClaims(join(dir, "claims.json"), claim(emptyStore(), key, 1).state);
    await saveAgents(join(dir, "agents.json"), putAgent(emptyAgentStore(), makeAgent({ id: "@a1", directory: key, durableSessionId: "seed-session-id", liveSessionId: "seed-session-id" })));

    let launchCalls = 0;
    let pendingEntry: { id: string; sessionId: string } | undefined;
    const runCommand = async (argv: string[]) => {
      if (argv[0] === "claude" && argv[1] === "agents") {
        const listing = pendingEntry ? [{ id: pendingEntry.id, sessionId: pendingEntry.sessionId, cwd: key, startedAt: 1, kind: "background" }] : [];
        pendingEntry = undefined;
        return { exitCode: 0, stdout: JSON.stringify(listing), stderr: "" };
      }
      if (argv[0] === "systemd-run") {
        launchCalls += 1;
        const shortId = `short-${launchCalls}`;
        pendingEntry = { id: shortId, sessionId: `phantom-session-${shortId}` };
        return { exitCode: 0, stdout: `backgrounded · ${shortId} (idle — send a prompt to start)\n`, stderr: "" };
      }
      throw new Error(`unexpected argv: ${JSON.stringify(argv)}`);
    };

    const deps = baseDeps(dir, runCommand);
    let state = initialDaemonState();
    for (let i = 0; i < 10; i++) {
      const result = await runReconcileCycle(state, deps);
      state = { claimDegraded: result.claimDegraded, agentsDegraded: result.agentsDegraded, orphanReportSignatures: result.orphanReportSignatures };
    }

    expect(launchCalls).toBeLessThanOrEqual(3);
    expect(launchCalls).toBeGreaterThan(0);

    const finalState = await loadAgents(join(dir, "agents.json"));
    expect(finalState.status).toBe("loaded");
    if (finalState.status === "loaded") expect(unresolvedLaunches(finalState.state).length).toBeGreaterThan(0);

    const launchCallsAtConvergence = launchCalls;
    for (let i = 0; i < 5; i++) {
      const result = await runReconcileCycle(state, deps);
      state = { claimDegraded: result.claimDegraded, agentsDegraded: result.agentsDegraded, orphanReportSignatures: result.orphanReportSignatures };
    }
    expect(launchCalls).toBe(launchCallsAtConvergence);
  });
});

describe("regression (PR #7 review, ported): a crash mid-launch must not silently wedge a session's restore forever", () => {
  test("a record left with no launchShortId and no error is recovered, logged, and never silently blocks restore going forward", async () => {
    const dir = await makeTempDir();
    const key = "/claimed/dir" as ClaimKey;
    await saveClaims(join(dir, "claims.json"), claim(emptyStore(), key, 1).state);
    let store = putAgent(emptyAgentStore(), makeAgent({ id: "@a1", directory: key, durableSessionId: "stale-prior-session", liveSessionId: "stale-prior-session" }));
    store = { ...store, launches: [{ attemptId: "wedged-attempt", agentId: "@a1", key, priorSessionId: "stale-prior-session", attemptedAt: 1000, launchShortId: undefined, error: undefined }] };
    await saveAgents(join(dir, "agents.json"), store);

    let launchCalls = 0;
    const deps = baseDeps(dir, async (argv) => {
      if (argv[0] === "systemd-run") launchCalls += 1;
      return { exitCode: 0, stdout: "[]", stderr: "" };
    });

    const result = await runReconcileCycle(initialDaemonState(), deps);

    const reloadedAfter = await loadAgents(join(dir, "agents.json"));
    expect(reloadedAfter.status).toBe("loaded");
    if (reloadedAfter.status === "loaded") {
      expect(unresolvedLaunches(reloadedAfter.state)).toHaveLength(1);
      expect(unresolvedLaunches(reloadedAfter.state)[0]?.error).toMatch(/ended before this launch's outcome was recorded/);
    }
    expect(launchCalls).toBe(0); // never auto-retried — still blocked by the promoted (now errored) record
    expect(result.restored).toEqual([]);
  });
});

describe("Constraint 2: a failed launch is recorded, never retried automatically", () => {
  test("across repeated cycles, the failed launch is logged but launch() is called exactly once", async () => {
    const dir = await makeTempDir();
    const key = "/claimed/dir" as ClaimKey;
    await saveClaims(join(dir, "claims.json"), claim(emptyStore(), key, 1).state);
    await saveAgents(join(dir, "agents.json"), putAgent(emptyAgentStore(), makeAgent({ id: "@a1", directory: key, durableSessionId: "old-session-id", liveSessionId: "old-session-id" })));

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

    const result2 = await runReconcileCycle({ claimDegraded: result1.claimDegraded, agentsDegraded: result1.agentsDegraded, orphanReportSignatures: result1.orphanReportSignatures }, deps);
    expect(result2.restored).toEqual([]);
    expect(launchCalls).toBe(1);
  });
});

describe("AC14: a given-up (errored) v1 launch record must keep blocking its migrated agent's restore, with the negative control that a HEALTHY migrated agent IS restored", () => {
  test("migration attributes the errored record to the correct agent via the durableSessionId->agentId correspondence, and that block survives across many cycles", async () => {
    const dir = await makeTempDir();
    const key = "/claimed/dir" as ClaimKey;
    await saveClaims(join(dir, "claims.json"), claim(emptyStore(), key, 1).state);

    let slots = emptySessionSlots();
    // A HEALTHY on-slot.
    slots = beginLaunch(slots, key, undefined, "healthy-seed", 1);
    slots = markLaunchStarted(slots, "healthy-seed", "healthy-short");
    slots = resolveLaunch(slots, "healthy-short", "healthy-durable-id");
    // A SECOND, healthy on-slot whose restore was given up on (error set) before migration.
    slots = beginLaunch(slots, key, undefined, "given-up-seed", 1);
    slots = markLaunchStarted(slots, "given-up-seed", "given-up-short");
    slots = resolveLaunch(slots, "given-up-short", "given-up-durable-id");
    slots = beginLaunch(slots, key, "given-up-durable-id", "given-up-restore-attempt", 2000);
    slots = markLaunchFailed(slots, "given-up-restore-attempt", "gave up after 3 consecutive restore attempts — pre-migration");
    await writeFile(join(dir, "session-slots.json"), serializeSessionSlotsState(slots), "utf8");

    const fake = makeFakeClaude(); // empty listing every cycle -> both agents look "absent", so the block is the only thing stopping a relaunch of the given-up one
    const deps = baseDeps(dir, fake.runCommand);

    let state = initialDaemonState();
    let cycles: Awaited<ReturnType<typeof runReconcileCycle>>[] = [];
    for (let i = 0; i < 5; i++) {
      const result = await runReconcileCycle(state, deps);
      cycles.push(result);
      state = { claimDegraded: result.claimDegraded, agentsDegraded: result.agentsDegraded, orphanReportSignatures: result.orphanReportSignatures };
    }

    const finalState = await loadAgents(join(dir, "agents.json"));
    expect(finalState.status).toBe("loaded");
    if (finalState.status !== "loaded") return;

    const healthyAgent = Object.values(finalState.state.agents).find((a) => a.durableSessionId === "healthy-durable-id");
    const givenUpAgent = Object.values(finalState.state.agents).find((a) => a.durableSessionId === "given-up-durable-id");
    expect(healthyAgent).toBeDefined();
    expect(givenUpAgent).toBeDefined();

    // The given-up agent's block SURVIVED the migration: zero launches for it across every cycle.
    const allRestoredAgentIds = cycles.flatMap((c) => c.restored.map((r) => r.agentId));
    expect(allRestoredAgentIds).not.toContain(givenUpAgent!.id);
    // NEGATIVE CONTROL: the healthy migrated agent WAS restored — without this, the check above can't tell "correctly blocked" from "launched nothing at all".
    expect(allRestoredAgentIds).toContain(healthyAgent!.id);

    // And the given-up record itself is still on record, unresolved, still attributed to the right agent.
    const stillUnresolved = unresolvedLaunches(finalState.state).find((l) => l.agentId === givenUpAgent!.id);
    expect(stillUnresolved).toBeDefined();
  });
});

describe("BAKR-24 Q4: report, don't launch — an orphaned claim's on-agents are never launched, and never create a launch record", () => {
  test("real directories: a claim whose directory is DELETED gets zero launches over several cycles; the NEGATIVE CONTROL — an ordinary 'on' agent in a directory that still resolves — IS launched in the SAME run; the report names the missing directory, not systemd-run", async () => {
    const storeDir = await makeTempDir();
    const presentDir = await mkdtemp(join(tmpdir(), "bakr-q4-present-"));
    cleanupDirs.push(presentDir);
    const goneDirParent = await mkdtemp(join(tmpdir(), "bakr-q4-gone-parent-"));
    cleanupDirs.push(goneDirParent);
    const goneDir = join(goneDirParent, "moved-away") as ClaimKey;
    await mkdir(goneDir);
    // Delete it BEFORE any reconcile cycle runs — a genuine orphan from cycle 1.
    await rm(goneDir, { recursive: true, force: true });

    const presentKey = presentDir as ClaimKey;

    let claimState = emptyStore();
    claimState = claim(claimState, presentKey, 1).state;
    claimState = claim(claimState, goneDir, 1).state;
    await saveClaims(join(storeDir, "claims.json"), claimState);

    let agentState = emptyAgentStore();
    agentState = putAgent(agentState, makeAgent({ id: "@present-agent", directory: presentKey }));
    agentState = putAgent(agentState, makeAgent({ id: "@orphan-agent", directory: goneDir }));
    await saveAgents(join(storeDir, "agents.json"), agentState);

    const launchedCwds: string[] = [];
    const runCommand = async (argv: string[], opts: RunCommandOptions) => {
      if (argv[0] === "claude" && argv[1] === "agents") return { exitCode: 0, stdout: "[]", stderr: "" };
      if (argv[0] === "systemd-run") {
        launchedCwds.push(opts.cwd ?? "");
        return { exitCode: 0, stdout: "backgrounded · short-x (idle — send a prompt to start)\n", stderr: "" };
      }
      throw new Error(`unexpected argv: ${JSON.stringify(argv)}`);
    };

    const deps: DaemonDeps = { ...baseDeps(storeDir, runCommand), probeDeps: realOrphanProbeDeps };

    const capturedLines: string[] = [];
    const originalConsoleLog = console.log;
    console.log = (...args: unknown[]) => {
      capturedLines.push(args.map(String).join(" "));
    };
    let state = initialDaemonState();
    try {
      for (let i = 0; i < 3; i++) {
        const result = await runReconcileCycle(state, deps);
        state = { claimDegraded: result.claimDegraded, agentsDegraded: result.agentsDegraded, orphanReportSignatures: result.orphanReportSignatures };
      }
    } finally {
      console.log = originalConsoleLog;
    }

    // The orphan was NEVER launched, across every cycle.
    expect(launchedCwds).not.toContain(goneDir);
    // NEGATIVE CONTROL: the present-directory agent WAS launched in this same run — proves the harness can observe a launch at all, so the zero above means "correctly skipped", not "launched nothing anywhere".
    expect(launchedCwds).toContain(presentDir);

    // No launch record was ever created for the orphaned agent (Q4: "create no launch record at all").
    const finalAgents = await loadAgents(join(storeDir, "agents.json"));
    expect(finalAgents.status).toBe("loaded");
    if (finalAgents.status === "loaded") {
      expect(finalAgents.state.launches.some((l) => l.agentId === "@orphan-agent")).toBe(false);
    }

    // The report names the missing directory and the agent, and does NOT echo a systemd-run/ENOENT-shaped explanation.
    const orphanLogLines = capturedLines.filter((line) => line.includes("@orphan-agent"));
    expect(orphanLogLines.length).toBeGreaterThan(0);
    expect(orphanLogLines[0]).toContain(goneDir);
    expect(orphanLogLines[0]).toMatch(/verdict: gone/);
    expect(orphanLogLines[0]).not.toMatch(/posix_spawn|systemd-run:/);

    // Reported on STATE CHANGE only, not once per cycle — 3 cycles, but the orphan's status never changed after cycle 1, so exactly one report line for it.
    expect(orphanLogLines).toHaveLength(1);
  });
});
