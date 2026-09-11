// BAKR-22, the epic's "missing job with a live conversation" condition:
// if claude has removed the job entry, `respawn` correctly refuses with
// "No job matching". The OPERATOR's `on` needs a recovery route that does
// not lose the conversation (an explicit, reported `forkFrom`); the loop
// (daemon.ts) never does this automatically. Both halves demonstrated
// through the REAL entry points — `on()` and `runReconcileCycle` — not a
// hand-written replica.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyAgentStore, putAgent, type AgentRecord } from "../../src/agent-model";
import { save as saveAgents, load as loadAgents } from "../../src/agent-store-io";
import { claim, emptyStore } from "../../src/claim-model";
import { save as saveClaims } from "../../src/claim-store-io";
import { on, type AgentActionDeps } from "../../src/agent-actions";
import { initialDaemonState, runReconcileCycle, type DaemonDeps } from "../../src/daemon";
import type { ClaimKey } from "../../src/claim-key-resolve";
import type { OrphanProbeDeps } from "../../src/orphan-probe";
import type { TranscriptProbeDeps } from "../../src/transcript-probe";
import type { RunCommand } from "../../src/spawn";

const alwaysPresentProbeDeps: OrphanProbeDeps = { stat: async () => ({ dev: 1, ino: 1, isDirectory: () => true }) };
const KEY = "/claimed/dir" as ClaimKey;
const AGENT_ID = "@missing-job-agent";
const SHORT_ID = "goneshort";
const SESSION_ID = "gone-session-uuid";
const MISSING_JOB_ERROR = `respawn exited 1: No job matching '${SHORT_ID}'`;

const cleanupDirs: string[] = [];
afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});
async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bakr-missing-job-test-"));
  cleanupDirs.push(dir);
  return dir;
}

function agentWithRestoreTarget(): AgentRecord {
  return { id: AGENT_ID, name: undefined, directory: KEY, state: "on", createdAt: 1, birthSessionId: "birth", restoreTarget: { sessionId: SESSION_ID, shortId: SHORT_ID } };
}

const hasTranscript: TranscriptProbeDeps = { listProjectDirs: async () => ({ ok: true, dirs: ["-tmp-dir"] }), transcriptExistsIn: async () => ({ ok: true, exists: true }) };

function makeFakeClaude(capturedLaunchArgv: string[][]): RunCommand {
  return async (argv) => {
    if (argv[0] === "claude" && argv[1] === "agents") return { exitCode: 0, stdout: "[]", stderr: "" };
    if (argv[0] === "claude" && argv[1] === "respawn") return { exitCode: 1, stdout: "", stderr: MISSING_JOB_ERROR };
    if (argv[0] === "systemd-run") {
      capturedLaunchArgv.push(argv);
      return { exitCode: 0, stdout: "backgrounded · newshort\n", stderr: "" };
    }
    throw new Error(`unexpected command: ${JSON.stringify(argv)}`);
  };
}

describe("the missing-job recovery route (BAKR-22)", () => {
  test("on() recovers via an explicit, REPORTED forkFrom when respawn says 'No job matching'", async () => {
    const dir = await makeTempDir();
    let state = emptyAgentStore();
    state = putAgent(state, agentWithRestoreTarget());
    await saveAgents(join(dir, "agents.json"), state);

    const capturedLaunchArgv: string[][] = [];
    let counter = 0;
    const deps: AgentActionDeps = {
      agentsPath: join(dir, "agents.json"),
      runCommand: makeFakeClaude(capturedLaunchArgv),
      now: () => 1_700_000_000_000,
      generateAttemptId: () => `attempt-${counter++}`,
      randomBytes: (n) => new Uint8Array(n).fill(1),
      transcriptProbeDeps: hasTranscript,
    };

    const result = await on(deps, KEY, AGENT_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // REPORTED, not silent — this is the whole point of the recovery route.
    expect(result.recovery?.kind).toBe("missing-job-recovery");
    expect(capturedLaunchArgv).toHaveLength(1);
    expect(capturedLaunchArgv[0]).toContain("--resume");
    expect(capturedLaunchArgv[0]).toContain(SESSION_ID);
    expect(capturedLaunchArgv[0]).toContain("--fork-session");

    const loaded = await loadAgents(join(dir, "agents.json"));
    if (loaded.status !== "loaded") throw new Error("expected loaded store");
    const forkAttempt = loaded.state.launches.find((l) => l.attemptKey?.kind === "forkFrom");
    expect(forkAttempt).toBeDefined();
  });

  test("the RECONCILE LOOP (daemon.ts) never does this automatically — the SAME 'No job matching' failure is just a typed refusal there, no forkFrom, per B7/B13", async () => {
    const dir = await makeTempDir();
    let state = emptyAgentStore();
    state = putAgent(state, agentWithRestoreTarget());
    await saveClaims(join(dir, "claims.json"), claim(emptyStore(), KEY, 1).state);
    await saveAgents(join(dir, "agents.json"), state);

    const capturedLaunchArgv: string[][] = [];
    let counter = 0;
    const deps: DaemonDeps = {
      runCommand: makeFakeClaude(capturedLaunchArgv),
      claimsPath: join(dir, "claims.json"),
      agentsPath: join(dir, "agents.json"),
      sessionSlotsPath: join(dir, "session-slots.json"),
      now: () => 1_700_000_000_000,
      generateAttemptId: () => `attempt-${counter++}`,
      randomBytes: (n) => new Uint8Array(n).fill(1),
      probeDeps: alwaysPresentProbeDeps,
      transcriptProbeDeps: hasTranscript,
    };

    await runReconcileCycle(initialDaemonState(), deps);

    // Falsifier: if the loop ALSO recognised "No job matching" and escaped
    // automatically, capturedLaunchArgv would be non-empty here.
    expect(capturedLaunchArgv).toHaveLength(0);

    const loaded = await loadAgents(join(dir, "agents.json"));
    if (loaded.status !== "loaded") throw new Error("expected loaded store");
    const forkAttempt = loaded.state.launches.find((l) => l.attemptKey?.kind === "forkFrom");
    expect(forkAttempt).toBeUndefined();
    const respawnFailure = loaded.state.launches.find((l) => l.attemptKey?.kind === "respawn");
    expect(respawnFailure?.error).toContain("No job matching");
  });
});
