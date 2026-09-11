// BAKR-22, the epic's "never-spoken-to-then-moved" condition, through the
// REAL daemon entry point (`runReconcileCycle`) — not a hand-written
// replica of the dispatch logic. Falsifier stated per test.

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
import type { TranscriptProbeDeps } from "../../src/transcript-probe";
import type { RunCommand } from "../../src/spawn";

const alwaysPresentProbeDeps: OrphanProbeDeps = { stat: async () => ({ dev: 1, ino: 1, isDirectory: () => true }) };
const KEY = "/claimed/dir" as ClaimKey;
const AGENT_ID = "@moved-agent";
const OLD_SHORT_ID = "oldshort";
const OLD_SESSION_ID = "old-session-uuid";

const cleanupDirs: string[] = [];
afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bakr-forkfrom-transcript-test-"));
  cleanupDirs.push(dir);
  return dir;
}

const STALE_CWD_ERROR = `respawn exited 1: Couldn't start a background session (working directory no longer exists or is not accessible: /tmp/old-claimed-dir)`;

function makeFakeClaude(capturedLaunchArgv: string[][]): RunCommand {
  return async (argv) => {
    if (argv[0] === "claude" && argv[1] === "agents") {
      return { exitCode: 0, stdout: "[]", stderr: "" }; // never listed -> "unknown" -> reachable for respawn
    }
    if (argv[0] === "claude" && argv[1] === "respawn") {
      return { exitCode: 1, stdout: "", stderr: STALE_CWD_ERROR };
    }
    if (argv[0] === "systemd-run") {
      capturedLaunchArgv.push(argv);
      return { exitCode: 0, stdout: "backgrounded · newshort\n", stderr: "" };
    }
    throw new Error(`unexpected command: ${JSON.stringify(argv)}`);
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

function agentWithRestoreTarget(): AgentRecord {
  return {
    id: AGENT_ID,
    name: undefined,
    directory: KEY,
    state: "on",
    createdAt: 1,
    birthSessionId: "birth",
    restoreTarget: { sessionId: OLD_SESSION_ID, shortId: OLD_SHORT_ID },
  };
}

describe("the never-spoken-to-then-moved decision (BAKR-22), through runReconcileCycle", () => {
  test("NO resumable transcript -> a BARE fresh launch, never --resume/--fork-session — falsifier: if the transcript check were ignored, this would still pass --fork-session and later fail on first prompt", async () => {
    const dir = await makeTempDir();
    let state = emptyAgentStore();
    state = putAgent(state, agentWithRestoreTarget());
    await saveClaims(join(dir, "claims.json"), claim(emptyStore(), KEY, 1).state);
    await saveAgents(join(dir, "agents.json"), state);

    const capturedLaunchArgv: string[][] = [];
    const noTranscript: TranscriptProbeDeps = { listProjectDirs: async () => ({ ok: true, dirs: [] }), transcriptExistsIn: async () => ({ ok: true, exists: false }) };
    const deps = baseDeps(dir, makeFakeClaude(capturedLaunchArgv), noTranscript);

    await runReconcileCycle(initialDaemonState(), deps);

    expect(capturedLaunchArgv).toHaveLength(1);
    const argv = capturedLaunchArgv[0] as string[];
    expect(argv).not.toContain("--resume");
    expect(argv).not.toContain("--fork-session");
    expect(argv).toContain("claude");
    expect(argv).toContain("--bg");
  });

  test("a resumable transcript EXISTS -> the real forkFrom escape, --resume <oldSessionId> --fork-session", async () => {
    const dir = await makeTempDir();
    let state = emptyAgentStore();
    state = putAgent(state, agentWithRestoreTarget());
    await saveClaims(join(dir, "claims.json"), claim(emptyStore(), KEY, 1).state);
    await saveAgents(join(dir, "agents.json"), state);

    const capturedLaunchArgv: string[][] = [];
    const hasTranscript: TranscriptProbeDeps = { listProjectDirs: async () => ({ ok: true, dirs: ["-tmp-old"] }), transcriptExistsIn: async () => ({ ok: true, exists: true }) };
    const deps = baseDeps(dir, makeFakeClaude(capturedLaunchArgv), hasTranscript);

    await runReconcileCycle(initialDaemonState(), deps);

    expect(capturedLaunchArgv).toHaveLength(1);
    const argv = capturedLaunchArgv[0] as string[];
    expect(argv).toContain("--resume");
    expect(argv).toContain(OLD_SESSION_ID);
    expect(argv).toContain("--fork-session");
  });

  test("could-not-tell (the projects root could not be listed) -> NO launch at all, never a guess in either direction — falsifier: if could-not-tell were folded into no-transcript, this would still see a bare launch", async () => {
    const dir = await makeTempDir();
    let state = emptyAgentStore();
    state = putAgent(state, agentWithRestoreTarget());
    await saveClaims(join(dir, "claims.json"), claim(emptyStore(), KEY, 1).state);
    await saveAgents(join(dir, "agents.json"), state);

    const capturedLaunchArgv: string[][] = [];
    const couldNotTell: TranscriptProbeDeps = { listProjectDirs: async () => ({ ok: false, reason: "EACCES" }), transcriptExistsIn: async () => ({ ok: true, exists: false }) };
    const deps = baseDeps(dir, makeFakeClaude(capturedLaunchArgv), couldNotTell);

    await runReconcileCycle(initialDaemonState(), deps);

    expect(capturedLaunchArgv).toHaveLength(0);
    const loaded = await loadAgents(join(dir, "agents.json"));
    if (loaded.status !== "loaded") throw new Error("expected loaded store");
    const forkAttempt = loaded.state.launches.find((l) => l.attemptKey?.kind === "forkFrom");
    expect(forkAttempt).toBeUndefined();
  });

  test("either way, the escape attempt is recorded as forkFrom-kind, keyed on the OLD session id, and the original respawn attempt is recorded failed under its OWN short-id key (B13)", async () => {
    const dir = await makeTempDir();
    let state = emptyAgentStore();
    state = putAgent(state, agentWithRestoreTarget());
    await saveClaims(join(dir, "claims.json"), claim(emptyStore(), KEY, 1).state);
    await saveAgents(join(dir, "agents.json"), state);

    const noTranscript: TranscriptProbeDeps = { listProjectDirs: async () => ({ ok: true, dirs: [] }), transcriptExistsIn: async () => ({ ok: true, exists: false }) };
    const deps = baseDeps(dir, makeFakeClaude([]), noTranscript);

    await runReconcileCycle(initialDaemonState(), deps);

    const loaded = await loadAgents(join(dir, "agents.json"));
    if (loaded.status !== "loaded") throw new Error("expected loaded store");
    const launches = loaded.state.launches;
    const respawnFailure = launches.find((l) => l.attemptKey?.kind === "respawn" && (l.attemptKey as { shortId: string }).shortId === OLD_SHORT_ID);
    const forkAttempt = launches.find((l) => l.attemptKey?.kind === "forkFrom");
    expect(respawnFailure?.error).toBeDefined();
    expect(forkAttempt).toBeDefined();
    expect((forkAttempt?.attemptKey as { sessionId: string }).sessionId).toBe(OLD_SESSION_ID);
  });
});
