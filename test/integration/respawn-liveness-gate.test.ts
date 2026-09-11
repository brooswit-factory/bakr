// BAKR-22, the epic's own flagged "sharpest correctness risk left": respawn
// on a session that is `alive` or `not-verifiable` kills and restarts its
// process (measured on the ticket: the pid changes even for an idle,
// cleanly-completed session). THERE IS NO "dead" VERDICT — `decideLiveness`
// (liveness.ts) produces exactly `alive | not-verifiable | unknown`, and
// `unknown`'s own doc comment is explicit it is "not proof of death", only
// absence from the listing. This file locks in the actual gate — reachable
// ONLY on `unknown` — via `decideAndBeginForAgent`, the REAL exported
// decision function (never a hand-written replica — same discipline
// test/integration/agent-decide-race.test.ts already established for this
// exact function), asserting against all three named verdicts.
//
// Falsifier for each test stated in its own name/body.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyAgentStore, putAgent, type AgentRecord } from "../../src/agent-model";
import { save as saveAgents } from "../../src/agent-store-io";
import { decideAndBeginForAgent, type DaemonDeps } from "../../src/daemon";
import type { ClaimKey } from "../../src/claim-key-resolve";
import type { OrphanProbeDeps } from "../../src/orphan-probe";
import type { BackgroundSessionInfo, RunCommand } from "../../src/spawn";

const alwaysPresentProbeDeps: OrphanProbeDeps = { stat: async () => ({ dev: 1, ino: 1, isDirectory: () => true }) };
const KEY = "/claimed/dir" as ClaimKey;
const AGENT_ID = "@liveness-gate-agent";
const SHORT_ID = "shortid1";

const cleanupDirs: string[] = [];
afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bakr-liveness-gate-test-"));
  cleanupDirs.push(dir);
  return dir;
}

function baseDeps(dir: string, runCommand: RunCommand): DaemonDeps {
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
  };
}

function agentWithRestoreTarget(): AgentRecord {
  return {
    id: AGENT_ID,
    name: undefined,
    directory: KEY,
    state: "on",
    createdAt: 1,
    birthSessionId: "birth-session",
    restoreTarget: { sessionId: "current-session", shortId: SHORT_ID },
  };
}

/** A `claude agents --json` stub returning exactly one listing entry (or none). */
function listingRunCommand(entry: BackgroundSessionInfo | undefined): RunCommand {
  return async (argv) => {
    if (argv[0] === "claude" && argv[1] === "agents") {
      return { exitCode: 0, stdout: JSON.stringify(entry ? [entry] : []), stderr: "" };
    }
    throw new Error(`unexpected command in this test: ${JSON.stringify(argv)}`);
  };
}

describe("the liveness gate before respawn (BAKR-22, epic risk 2)", () => {
  test("ALIVE (verified pid) never reaches begin-respawn — falsifier: if the gate were removed, this would return begin-respawn and the caller would kill a live process", async () => {
    const dir = await makeTempDir();
    let state = emptyAgentStore();
    state = putAgent(state, agentWithRestoreTarget());
    await saveAgents(join(dir, "agents.json"), state);

    const deps = baseDeps(dir, listingRunCommand({ id: SHORT_ID, cwd: KEY, startedAt: 0, sessionId: "current-session", pid: process.pid, state: "blocked" }));
    const outcome = await decideAndBeginForAgent(deps, AGENT_ID, KEY, [{ id: SHORT_ID, cwd: KEY, startedAt: 0, sessionId: "current-session", pid: process.pid, state: "blocked" }]);

    expect(outcome.malformed).toBe(false);
    expect(outcome.decision?.kind).toBe("alive");
  });

  test("NOT-VERIFIABLE (listed, but no pid reported this cycle) never reaches begin-respawn — falsifier: treating 'no pid reported' as dead would risk a duplicate against a session merely between reports", async () => {
    const dir = await makeTempDir();
    let state = emptyAgentStore();
    state = putAgent(state, agentWithRestoreTarget());
    await saveAgents(join(dir, "agents.json"), state);

    const entryNoPid: BackgroundSessionInfo = { id: SHORT_ID, cwd: KEY, startedAt: 0, sessionId: "current-session", pid: undefined, state: "blocked" };
    const deps = baseDeps(dir, listingRunCommand(entryNoPid));
    const outcome = await decideAndBeginForAgent(deps, AGENT_ID, KEY, [entryNoPid]);

    expect(outcome.malformed).toBe(false);
    expect(outcome.decision?.kind).toBe("not-verifiable");
  });

  test("UNKNOWN (not present in the listing at all — NOT proof of death per decideLiveness's own doc, merely the only verdict this design acts on) is the ONLY verdict that reaches begin-respawn, keyed on the SHORT id", async () => {
    const dir = await makeTempDir();
    let state = emptyAgentStore();
    state = putAgent(state, agentWithRestoreTarget());
    await saveAgents(join(dir, "agents.json"), state);

    const deps = baseDeps(dir, listingRunCommand(undefined));
    const outcome = await decideAndBeginForAgent(deps, AGENT_ID, KEY, []);

    expect(outcome.malformed).toBe(false);
    expect(outcome.decision?.kind).toBe("begin-respawn");
    if (outcome.decision?.kind === "begin-respawn") {
      expect(outcome.decision.shortId).toBe(SHORT_ID);
      expect(outcome.decision.restoreSessionId).toBe("current-session");
    }
  });

  test("a pid that is listed but does NOT independently verify as alive (process.kill probe fails) is not-verifiable, never begin-respawn", async () => {
    const dir = await makeTempDir();
    let state = emptyAgentStore();
    state = putAgent(state, agentWithRestoreTarget());
    await saveAgents(join(dir, "agents.json"), state);

    // A pid astronomically unlikely to be alive on this machine right now.
    const bogusPid = 999_999_999;
    const entry: BackgroundSessionInfo = { id: SHORT_ID, cwd: KEY, startedAt: 0, sessionId: "current-session", pid: bogusPid, state: "blocked" };
    const deps = baseDeps(dir, listingRunCommand(entry));
    const outcome = await decideAndBeginForAgent(deps, AGENT_ID, KEY, [entry]);

    expect(outcome.malformed).toBe(false);
    expect(outcome.decision?.kind).toBe("not-verifiable");
  });
});
