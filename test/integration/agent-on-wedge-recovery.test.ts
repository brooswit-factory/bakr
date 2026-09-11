// Criterion 11 (epic ruling B13, added 2026-09-11, at the END of the
// definition of done per BAKR-16's own renumbering hazard): drive an agent
// into a GENUINELY wedged state — record launch intent, kill the process
// before the outcome is recorded, run a real reconcile cycle so the record
// is promoted to failed — then show `on` clearing it, reporting the clear,
// and the agent launching again. TWO required controls:
//   (a) the SAME probe against code without the clearing handling must show
//       the wedge persisting — otherwise this harness cannot tell a real
//       recovery from one that merely looks like one.
//   (b) the reconcile LOOP itself never clears such a record (B13: "the
//       reconcile loop never does... the daemon's give-up stays final") —
//       armed to fail loudly if it ever tries.
//
// Falsifier, stated first, for the CONFIRMED wedge itself (already verified
// once on BAKR-21's own ticket, re-demonstrated here against real code
// rather than by-eye reading): it would be false if `hasLaunchRecordFor`
// filtered on `error === undefined`, or if any code path besides this
// story's own `clearFailedLaunchRecord` ever removed a failed record.
//
// Covers BOTH shapes B13/criterion 11 care about: an agent already "on"
// stuck on a wedged FRESH launch (the `create`-crashes shape), and an
// agent "off" stuck on a wedged RESTORE launch (the `on`-crashes shape).

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claim, emptyStore } from "../../src/claim-model";
import { save as saveClaims } from "../../src/claim-store-io";
import { emptyAgentStore, hasLaunchRecordFor, putAgent, type AgentRecord } from "../../src/agent-model";
import { save as saveAgents, load as loadAgents, withAgentStoreLock } from "../../src/agent-store-io";
import { initialDaemonState, runReconcileCycle, type DaemonDeps } from "../../src/daemon";
import { on, type AgentActionDeps } from "../../src/agent-actions";
import type { ClaimKey } from "../../src/claim-key-resolve";
import type { RunCommandOptions, CommandResult } from "../../src/spawn";

const KEY = "/claimed/dir" as ClaimKey;

const cleanupDirs: string[] = [];
async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bakr-wedge-"));
  cleanupDirs.push(dir);
  return dir;
}

/** Armed to THROW on any `claude stop` (B7/B13's loop-never-stops-or-clears falsifier) — a daemon cycle that ever tried would fail this test loudly rather than silently passing. */
function makeDaemonStub() {
  let agentsListingCalls = 0;
  async function runCommand(argv: string[], _opts: RunCommandOptions): Promise<CommandResult> {
    if (argv[0] === "claude" && argv[1] === "agents") {
      agentsListingCalls += 1;
      return { exitCode: 0, stdout: "[]", stderr: "" };
    }
    if (argv[0] === "claude" && argv[1] === "stop") {
      throw new Error(`FALSIFIER TRIPPED: the reconcile loop must never stop or otherwise act on this agent — got: ${JSON.stringify(argv)}`);
    }
    throw new Error(`daemon stub: unexpected argv ${JSON.stringify(argv)} (the daemon must not launch an off/archived agent, and must not need to launch this already-on agent without a fresh decision)`);
  }
  return { runCommand, getAgentsListingCalls: () => agentsListingCalls };
}

function daemonDeps(dir: string, runCommand: DaemonDeps["runCommand"]): DaemonDeps {
  let counter = 0;
  return {
    runCommand,
    claimsPath: join(dir, "claims.json"),
    agentsPath: join(dir, "agents.json"),
    sessionSlotsPath: join(dir, "session-slots.json"),
    now: () => 1_700_000_000_000,
    generateAttemptId: () => `daemon-attempt-${counter++}`,
    randomBytes: (n: number) => new Uint8Array(n).fill(7),
  };
}

function actionDeps(dir: string, runCommand: AgentActionDeps["runCommand"]): AgentActionDeps {
  let counter = 0;
  return {
    agentsPath: join(dir, "agents.json"),
    runCommand,
    now: () => 1_700_000_000_001,
    generateAttemptId: () => `verb-attempt-${counter++}`,
    randomBytes: (n: number) => new Uint8Array(n).fill(9),
  };
}

async function seedClaim(dir: string): Promise<void> {
  await saveClaims(join(dir, "claims.json"), claim(emptyStore(), KEY, 1).state);
}

/** Simulates "a verb recorded `beginLaunch` and then the process died before recording the outcome" — the EXACT shape this story's `on`/`create` leave behind mid-flight, never calling `markLaunchStarted`/`markLaunchFailed`. */
async function wedgeAgent(agentsPath: string, agent: AgentRecord, priorSessionId: string | undefined): Promise<void> {
  await saveAgents(agentsPath, putAgent(emptyAgentStore(), agent));
  await withAgentStoreLock(agentsPath, (current) => {
    const next = { ...current, launches: [...current.launches, { attemptId: "wedge-attempt", agentId: agent.id, key: agent.directory, priorSessionId, attemptedAt: 1, launchShortId: undefined, error: undefined }] };
    return { state: next, result: undefined };
  });
}

/** NEGATIVE CONTROL (a): the UNHANDLED shape — checks `hasLaunchRecordFor` (exactly as the daemon's own guard does) but has no `clearFailedLaunchRecord` step at all. Reproduces the permanent-block bug this story's `on` fixes. */
async function unhandledOnAttempt(agentsPath: string, agentId: string, priorSessionId: string | undefined): Promise<"blocked" | "would-launch"> {
  const loaded = await loadAgents(agentsPath);
  if (loaded.status !== "loaded") throw new Error("expected a loaded store");
  return hasLaunchRecordFor(loaded.state, agentId, priorSessionId) ? "blocked" : "would-launch";
}

describe("Criterion 11: a genuinely wedged launch record is cleared by `on`, reported, and never cleared by the reconcile loop", () => {
  test("shape 1 — an already-ON agent wedged on a FRESH launch (the `create`-crashes shape)", async () => {
    const dir = await makeTempDir();
    try {
      const agentsPath = join(dir, "agents.json");
      await seedClaim(dir);
      const agent: AgentRecord = { id: "@wedge-fresh0000000", name: undefined, directory: KEY, state: "on", createdAt: 1, durableSessionId: undefined, liveSessionId: undefined };
      await wedgeAgent(agentsPath, agent, undefined);

      // STEP: run a REAL reconcile cycle so the record is promoted to failed — the CONFIRMED hazard, reproduced against real code.
      const daemonStub = makeDaemonStub();
      const afterCycle1 = await runReconcileCycle(initialDaemonState(), daemonDeps(dir, daemonStub.runCommand));
      expect(afterCycle1.agentsDegraded).toBe(false);

      const afterCycle1Store = await loadAgents(agentsPath);
      if (afterCycle1Store.status !== "loaded") throw new Error("expected loaded");
      const wedgedRecord = afterCycle1Store.state.launches.find((l) => l.agentId === agent.id);
      expect(wedgedRecord?.error).toBeDefined(); // CONFIRMED: promoted to failed by the daemon's own promoteWedgedLaunches

      // CONTROL (b): run several MORE cycles — the loop must never clear it (B13) and never try to launch/stop this already-on agent without a fresh decision basis. The stub is armed to throw on any `claude stop`; an unexpected launch attempt throws too.
      for (let i = 0; i < 3; i++) {
        await runReconcileCycle(initialDaemonState(), daemonDeps(dir, daemonStub.runCommand));
      }
      const stillWedged = await loadAgents(agentsPath);
      if (stillWedged.status !== "loaded") throw new Error("expected loaded");
      expect(stillWedged.state.launches.find((l) => l.agentId === agent.id)?.error).toBeDefined(); // still there, still failed — the loop did not touch it

      // CONTROL (a), NEGATIVE: the unhandled shape stays blocked forever — proving this harness can tell "wedged" from "recovered".
      expect(await unhandledOnAttempt(agentsPath, agent.id, undefined)).toBe("blocked");
      expect(await unhandledOnAttempt(agentsPath, agent.id, undefined)).toBe("blocked"); // still blocked on a repeat — no automatic healing

      // THE REAL RECOVERY: calling the shipped `on()` clears the wedge, reports it, and launches again.
      const launchRunCommand = async (argv: string[], opts: RunCommandOptions): Promise<CommandResult> => {
        if (argv[0] === "systemd-run") return { exitCode: 0, stdout: "backgrounded · recovered-short-0 (idle — send a prompt to start)\n", stderr: "" };
        throw new Error(`unexpected argv ${JSON.stringify(argv)}`);
      };
      const result = await on(actionDeps(dir, launchRunCommand), KEY, agent.id);
      expect(result.ok).toBe(true);
      if (result.ok && "wedgeCleared" in result) {
        expect(result.wedgeCleared).toBe(true); // REPORTED, not silent (B13 point 1)
        expect(result.launchIssued).toBe(true);
        expect(result.kind).toBe("no-change"); // lifecycle-wise it was already on — the wedge recovery is an orthogonal fact
      } else {
        throw new Error(`expected a wedge-cleared ok result, got ${JSON.stringify(result)}`);
      }

      const finalStore = await loadAgents(agentsPath);
      if (finalStore.status !== "loaded") throw new Error("expected loaded");
      const recordsForAgent = finalStore.state.launches.filter((l) => l.agentId === agent.id);
      expect(recordsForAgent.length).toBe(1); // the old failed record is GONE, replaced by exactly one fresh, pending one
      expect(recordsForAgent[0]?.error).toBeUndefined();
      expect(recordsForAgent[0]?.launchShortId).toBe("recovered-short-0");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 15000);

  test("shape 2 — an OFF agent wedged on a RESTORE launch (the `on`-crashes shape)", async () => {
    const dir = await makeTempDir();
    try {
      const agentsPath = join(dir, "agents.json");
      await seedClaim(dir);
      // Mid-flight shape: `on`'s lock-1 already committed state:"on" before the crash — see agent-actions.ts's `on`, lock-1 transitions before launch() runs.
      const agent: AgentRecord = { id: "@wedge-restore000000", name: undefined, directory: KEY, state: "on", createdAt: 1, durableSessionId: "durable-1", liveSessionId: undefined };
      await wedgeAgent(agentsPath, agent, "durable-1");

      const daemonStub = makeDaemonStub();
      await runReconcileCycle(initialDaemonState(), daemonDeps(dir, daemonStub.runCommand));

      const promoted = await loadAgents(agentsPath);
      if (promoted.status !== "loaded") throw new Error("expected loaded");
      expect(promoted.state.launches.find((l) => l.agentId === agent.id)?.error).toBeDefined();

      expect(await unhandledOnAttempt(agentsPath, agent.id, "durable-1")).toBe("blocked");

      const launchRunCommand = async (argv: string[], opts: RunCommandOptions): Promise<CommandResult> => {
        if (argv[0] === "systemd-run") {
          // B8/resume check: the restore must pass exactly --resume durable-1, nothing else, as argv elements AFTER "claude --bg".
          const dashIdx = argv.indexOf("--");
          const claudeArgs = argv.slice(dashIdx + 3);
          expect(claudeArgs).toEqual(["--resume", "durable-1"]);
          return { exitCode: 0, stdout: "backgrounded · recovered-short-1 (idle — send a prompt to start)\n", stderr: "" };
        }
        throw new Error(`unexpected argv ${JSON.stringify(argv)}`);
      };
      const result = await on(actionDeps(dir, launchRunCommand), KEY, agent.id);
      expect(result.ok).toBe(true);
      if (result.ok && "wedgeCleared" in result) {
        expect(result.wedgeCleared).toBe(true);
        expect(result.launchIssued).toBe(true);
      } else {
        throw new Error(`expected a wedge-cleared ok result, got ${JSON.stringify(result)}`);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 15000);

  test("CONTROL: `on` does NOT clear a record that is genuinely in flight (not yet failed) — never duplicates a live launch", async () => {
    const dir = await makeTempDir();
    try {
      const agentsPath = join(dir, "agents.json");
      await seedClaim(dir);
      const agent: AgentRecord = { id: "@in-flight00000000", name: undefined, directory: KEY, state: "off", durableSessionId: undefined, liveSessionId: undefined, createdAt: 1 };
      await wedgeAgent(agentsPath, agent, undefined); // NOTE: no reconcile cycle run — the record is still pending, never promoted to failed.

      const runCommand = async (argv: string[]): Promise<CommandResult> => {
        throw new Error(`FALSIFIER TRIPPED: must never call launch for an in-flight record — got ${JSON.stringify(argv)}`);
      };
      const result = await on(actionDeps(dir, runCommand), KEY, agent.id);
      expect(result.ok).toBe(true);
      if (result.ok && "wedgeCleared" in result) {
        expect(result.wedgeCleared).toBe(false);
        expect(result.launchIssued).toBe(false);
      } else {
        throw new Error(`expected ok, got ${JSON.stringify(result)}`);
      }

      const store = await loadAgents(agentsPath);
      if (store.status !== "loaded") throw new Error("expected loaded");
      expect(store.state.launches.filter((l) => l.agentId === agent.id).length).toBe(1); // the original in-flight record, untouched
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 15000);
});
