// BAKR-23's caught incident: the TOCTOU re-check inside
// `dispatchRespawnForDaemon` (daemon.ts) originally treated a THROWN
// listing the same as "not alive" and proceeded to respawn anyway — an
// unannounced stop hidden inside "restore" (B7) caused by a transient CLI
// hiccup rather than any fact about the session. Fixed by routing the
// re-check through the real `checkLiveness`, whose verdict now
// distinguishes `absent` (listing succeeded, genuinely not found — the
// only verdict that proceeds) from `listing-failed` (the listing call
// itself threw — refuses, same as `alive`/`not-verifiable`).
//
// Falsifier: if `listing-failed` were still folded into "not alive"/
// "absent", `respawnSession` would be called and this test's
// `respawnWasCalled` would read `true`.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyAgentStore, putAgent, type AgentRecord } from "../../src/agent-model";
import { save as saveAgents, load as loadAgents } from "../../src/agent-store-io";
import { claim, emptyStore } from "../../src/claim-model";
import { save as saveClaims } from "../../src/claim-store-io";
import { initialDaemonState, runReconcileCycle, type DaemonDeps } from "../../src/daemon";
import type { ClaimKey } from "../../src/claim-key-resolve";
import type { OrphanProbeDeps } from "../../src/orphan-probe";
import type { RunCommand } from "../../src/spawn";

const alwaysPresentProbeDeps: OrphanProbeDeps = { stat: async () => ({ dev: 1, ino: 1, isDirectory: () => true }) };
const KEY = "/claimed/dir" as ClaimKey;
const AGENT_ID = "@toctou-agent";
const SHORT_ID = "toctoush";
const SESSION_ID = "toctou-session-uuid";

const cleanupDirs: string[] = [];
afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});
async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bakr-toctou-test-"));
  cleanupDirs.push(dir);
  return dir;
}

function agentWithRestoreTarget(): AgentRecord {
  return { id: AGENT_ID, name: undefined, directory: KEY, state: "on", createdAt: 1, birthSessionId: "birth", restoreTarget: { sessionId: SESSION_ID, shortId: SHORT_ID } };
}

describe("the TOCTOU re-check before respawn (BAKR-23's caught incident)", () => {
  test("a listing failure on the RE-CHECK (second `claude agents --json` call) refuses — respawnSession is NEVER called", async () => {
    const dir = await makeTempDir();
    let state = emptyAgentStore();
    state = putAgent(state, agentWithRestoreTarget());
    await saveClaims(join(dir, "claims.json"), claim(emptyStore(), KEY, 1).state);
    await saveAgents(join(dir, "agents.json"), state);

    let listingCallCount = 0;
    let respawnWasCalled = false;
    const runCommand: RunCommand = async (argv) => {
      if (argv[0] === "claude" && argv[1] === "agents") {
        listingCallCount += 1;
        if (listingCallCount === 1) {
          // The decision-phase listing (inside decideAndBeginForAgent):
          // session genuinely absent -> begin-respawn is chosen.
          return { exitCode: 0, stdout: "[]", stderr: "" };
        }
        // The TOCTOU RE-CHECK, immediately before the actual spawn: this
        // one THROWS-shaped (non-zero exit -> checkLiveness's catch path
        // via listBackgroundSessions throwing on non-zero exit).
        return { exitCode: 1, stdout: "", stderr: "claude: temporary failure, try again" };
      }
      if (argv[0] === "claude" && argv[1] === "respawn") {
        respawnWasCalled = true;
        return { exitCode: 0, stdout: "respawned\n", stderr: "" };
      }
      throw new Error(`unexpected command: ${JSON.stringify(argv)}`);
    };

    let counter = 0;
    const deps: DaemonDeps = {
      runCommand,
      claimsPath: join(dir, "claims.json"),
      agentsPath: join(dir, "agents.json"),
      sessionSlotsPath: join(dir, "session-slots.json"),
      now: () => 1_700_000_000_000,
      generateAttemptId: () => `attempt-${counter++}`,
      randomBytes: (n: number) => new Uint8Array(n).fill(1),
      probeDeps: alwaysPresentProbeDeps,
    };

    await runReconcileCycle(initialDaemonState(), deps);

    expect(respawnWasCalled).toBe(false);

    const loaded = await loadAgents(join(dir, "agents.json"));
    if (loaded.status !== "loaded") throw new Error("expected loaded store");
    const failed = loaded.state.launches.find((l) => l.attemptKey?.kind === "respawn");
    expect(failed?.error).toContain("listing-failed");
  });

  test("POSITIVE CONTROL: when the re-check listing genuinely succeeds and reports absent, respawnSession IS called — the refusal above is not because respawn is unreachable in general", async () => {
    const dir = await makeTempDir();
    let state = emptyAgentStore();
    state = putAgent(state, agentWithRestoreTarget());
    await saveClaims(join(dir, "claims.json"), claim(emptyStore(), KEY, 1).state);
    await saveAgents(join(dir, "agents.json"), state);

    let respawnWasCalled = false;
    const runCommand: RunCommand = async (argv) => {
      if (argv[0] === "claude" && argv[1] === "agents") return { exitCode: 0, stdout: "[]", stderr: "" };
      if (argv[0] === "claude" && argv[1] === "respawn") {
        respawnWasCalled = true;
        return { exitCode: 0, stdout: "respawned\n", stderr: "" };
      }
      throw new Error(`unexpected command: ${JSON.stringify(argv)}`);
    };

    let counter = 0;
    const deps: DaemonDeps = {
      runCommand,
      claimsPath: join(dir, "claims.json"),
      agentsPath: join(dir, "agents.json"),
      sessionSlotsPath: join(dir, "session-slots.json"),
      now: () => 1_700_000_000_000,
      generateAttemptId: () => `attempt-${counter++}`,
      randomBytes: (n: number) => new Uint8Array(n).fill(1),
      probeDeps: alwaysPresentProbeDeps,
    };

    await runReconcileCycle(initialDaemonState(), deps);
    expect(respawnWasCalled).toBe(true);
  });
});
