// BAKR-33: "Failed launch records for agents that are healthy again are
// never cleared, and the daemon re-reports them as ERROR on every start."
//
// Three independent fixes, each with its own falsifier:
//   1. A successful resolution (`resolveRespawnAttempt`/`resolveLaunch`,
//      reached via `relaunch`/`on`/the daemon's own reconcile loop) drops
//      that SAME agent's OTHER launch records that carry an error — see
//      test/unit/agent-model.test.ts for the pure-function-level coverage
//      of this; this file exercises it end-to-end through `relaunch`.
//   2. `archive` drops every launch record the archived agent carries
//      (same as `delete` already did) — an archived agent is never
//      restored again, so a record naming it is permanent noise otherwise.
//   3. The daemon's "unresolved launch" report loop does not re-log an
//      ERROR, on every cycle (including the very first cycle after a
//      restart), for an agent whose CURRENT restore target independently
//      verifies alive right now — restarting the small bakr process does
//      not touch the agents' own long-running sessions, so most agents
//      verify alive on cycle one, well before any new respawn ever runs to
//      trigger fix 1.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpSettingsIo } from "@brooswit/drovr";
import { emptyAgentStore, putAgent, type AgentRecord, type AgentStoreState, type LaunchRecord } from "../../src/agent-model";
import { save as saveAgents, load as loadAgents } from "../../src/agent-store-io";
import { claim, emptyStore } from "../../src/claim-model";
import { save as saveClaims } from "../../src/claim-store-io";
import { archive, relaunch, type AgentActionDeps } from "../../src/agent-actions";
import { initialDaemonState, runReconcileCycle, type DaemonDeps, type DaemonState } from "../../src/daemon";
import type { ClaimKey } from "../../src/claim-key-resolve";
import type { OrphanProbeDeps } from "../../src/orphan-probe";
import type { TranscriptProbeDeps } from "../../src/transcript-probe";
import type { RunCommand } from "../../src/spawn";
import { makeFakeHost } from "../support/fake-host";

const alwaysPresentProbeDeps: OrphanProbeDeps = { stat: async () => ({ dev: 1, ino: 1, isDirectory: () => true }) };
const KEY = "/claimed/dir" as ClaimKey;
const noTranscript: TranscriptProbeDeps = { listProjectDirs: async () => ({ ok: true, dirs: [] }), transcriptExistsIn: async () => ({ ok: true, exists: false }) };

const cleanupDirs: string[] = [];
afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});
async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bakr-launch-record-cleanup-"));
  cleanupDirs.push(dir);
  return dir;
}

const staleRecord = (agentId: string, attemptId: string, shortId: string, error: string): LaunchRecord => ({
  attemptId,
  agentId,
  key: KEY,
  attemptKey: { kind: "respawn", shortId },
  attemptedAt: 1,
  launchShortId: undefined,
  error,
});

// --- Fix 3: the daemon's report loop never re-logs a healthy agent -------

function daemonDeps(dir: string, runCommand: RunCommand): DaemonDeps {
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
    transcriptProbeDeps: noTranscript,
    launchConfigDeps: { readConfigFile: async () => undefined },
  };
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

describe("BAKR-33 fix 3: a daemon restart logs no unresolved-launch ERROR for an agent that is healthy right now", () => {
  test("a stale FAILED record under an OLD short id, for an agent whose CURRENT restore target independently verifies alive, is never reported — across several cycles, with no new respawn ever dispatched", async () => {
    const dir = await makeTempDir();
    await saveClaims(join(dir, "claims.json"), claim(emptyStore(), KEY, 1).state);

    const AGENT_ID = "@healthy-agent";
    let state = emptyAgentStore();
    state = putAgent(state, {
      id: AGENT_ID, name: undefined, directory: KEY, state: "on", createdAt: 1,
      birthSessionId: "durable-session", restoreTarget: { sessionId: "durable-session", shortId: "current-pane" },
    });
    state = { ...state, launches: [staleRecord(AGENT_ID, "old-failed-attempt", "long-gone-pane", "respawn refused: TOCTOU re-check reported \"alive\" for session long-gone-pane")] };
    await saveAgents(join(dir, "agents.json"), state);

    const fake = makeFakeHost();
    fake.addPane({ cwd: KEY, sessionId: "durable-session" }); // verifies alive: real pid (this test process), matched by sessionId
    const deps = daemonDeps(dir, fake.runCommand);

    const { capturedLines } = await runCycles(deps, 3);

    const unresolvedLines = capturedLines.filter((l) => l.includes("unresolved launch for agent") && l.includes(AGENT_ID));
    expect(unresolvedLines).toEqual([]); // FALSIFIER: without fix 3, cycle 1 alone logs this line
    expect(fake.starts()).toEqual([]); // never dispatched a new respawn either — this is a reporting suppression, not a retry

    // Reporting-only: the stale record itself is untouched on disk (fix 1 removes it only via an actual future resolution).
    const finalStore = await loadAgents(join(dir, "agents.json"));
    if (finalStore.status !== "loaded") throw new Error("expected loaded store");
    expect(finalStore.state.launches).toHaveLength(1);
  });

  test("NEGATIVE CONTROL: an identical stale record for an agent that does NOT verify alive is still reported every cycle — proves the suppression is keyed on verified liveness, not merely on having a restoreTarget", async () => {
    const dir = await makeTempDir();
    await saveClaims(join(dir, "claims.json"), claim(emptyStore(), KEY, 1).state);

    const AGENT_ID = "@down-agent";
    let state = emptyAgentStore();
    state = putAgent(state, {
      id: AGENT_ID, name: undefined, directory: KEY, state: "on", createdAt: 1,
      birthSessionId: "durable-session", restoreTarget: { sessionId: "durable-session", shortId: "current-pane" },
    });
    state = { ...state, launches: [staleRecord(AGENT_ID, "old-failed-attempt", "current-pane", "gave up after 3 consecutive restore attempts")] };
    await saveAgents(join(dir, "agents.json"), state);

    // No pane at all this time — the listing genuinely shows nothing for this agent (verdict "absent", not "alive").
    const fake = makeFakeHost();
    const deps = daemonDeps(dir, fake.runCommand);

    const { capturedLines } = await runCycles(deps, 2);

    const unresolvedLines = capturedLines.filter((l) => l.includes("unresolved launch for agent") && l.includes(AGENT_ID));
    expect(unresolvedLines).toHaveLength(2); // still reported every cycle — this agent is NOT verified alive
    // hasLaunchRecordFor still blocks a fresh automatic attempt at the same key (B7/B13, unrelated to this ticket).
    expect(fake.starts()).toEqual([]);
  });
});

// --- Fix 2: archive drops the archived agent's launch records ------------

function actionDeps(dir: string, runCommand: RunCommand): AgentActionDeps {
  let counter = 0;
  return {
    agentsPath: join(dir, "agents.json"),
    runCommand,
    now: () => 1_700_000_000_000,
    generateAttemptId: () => `attempt-${counter++}`,
    randomBytes: (n: number) => new Uint8Array(n).fill(1),
  };
}

describe("BAKR-33 fix 2: archive drops the archived agent's launch records, leaving other agents' alone", () => {
  test("a FAILED record for the archived agent is gone after archive; a sibling agent's own failed record is untouched", async () => {
    const dir = await makeTempDir();
    const ARCHIVED = "@to-archive";
    const SIBLING = "@sibling";
    let state = emptyAgentStore();
    state = putAgent(state, { id: ARCHIVED, name: "archived-one", directory: KEY, state: "off", createdAt: 1, birthSessionId: undefined, restoreTarget: undefined });
    state = putAgent(state, { id: SIBLING, name: "sibling", directory: KEY, state: "on", createdAt: 1, birthSessionId: "sib-session", restoreTarget: { sessionId: "sib-session", shortId: "sib-pane" } });
    state = { ...state, launches: [staleRecord(ARCHIVED, "archived-failed", "old-pane", "some past refusal"), staleRecord(SIBLING, "sibling-failed", "sib-old-pane", "unrelated refusal")] };
    await saveAgents(join(dir, "agents.json"), state);

    const fake = makeFakeHost();
    const result = await archive(actionDeps(dir, fake.runCommand), KEY, ARCHIVED);
    expect(result.ok).toBe(true);

    const finalStore = await loadAgents(join(dir, "agents.json"));
    if (finalStore.status !== "loaded") throw new Error("expected loaded store");
    expect(finalStore.state.launches.map((l) => l.attemptId)).toEqual(["sibling-failed"]); // FALSIFIER: without fix 2, "archived-failed" survives
    expect(finalStore.state.agents[ARCHIVED]?.state).toBe("archived");
  });

  test("a still-PENDING launch (never resolved) for the agent being archived is stopped by its own recorded short id first, then its record is dropped — never silently orphaned", async () => {
    const dir = await makeTempDir();
    const ARCHIVED = "@fresh-then-archived";
    let state = emptyAgentStore();
    state = putAgent(state, { id: ARCHIVED, name: undefined, directory: KEY, state: "on", createdAt: 1, birthSessionId: undefined, restoreTarget: undefined });
    // A fresh launch whose listing never resolved it (no `birthSessionId`/`restoreTarget` yet) — the ONLY handle on this session is the launch record's own short id.
    state = { ...state, launches: [{ attemptId: "fresh-pending", agentId: ARCHIVED, key: KEY, attemptKey: undefined, attemptedAt: 1, launchShortId: "w1:p1", error: undefined }] };
    await saveAgents(join(dir, "agents.json"), state);

    const fake = makeFakeHost();
    fake.addPane({ cwd: KEY, sessionId: "still-running-session" }); // mints as pane "w1:p1" (first pane) — the still-running session

    const result = await archive(actionDeps(dir, fake.runCommand), KEY, ARCHIVED);
    expect(result.ok).toBe(true);
    expect(fake.stops()).toEqual(["w1"]); // the still-running session was actually stopped, not just forgotten about

    const finalStore = await loadAgents(join(dir, "agents.json"));
    if (finalStore.status !== "loaded") throw new Error("expected loaded store");
    expect(finalStore.state.launches).toEqual([]);
  });
});

// --- Fix 1 (end-to-end): a successful relaunch clears older failed records

const RELAUNCH_MCP = JSON.stringify({ mcpServers: {} });
function memorySettings(): McpSettingsIo & { files: Record<string, string> } {
  const files: Record<string, string> = {};
  return { files, readSettings: async (p) => files[p], writeSettings: async (p, c) => { files[p] = c; } };
}

describe("BAKR-33 fix 1 (end-to-end via relaunch): a successful relaunch drops the SAME agent's older failed launch records", () => {
  test("an old failed respawn record under a DIFFERENT short id disappears once relaunch resolves a new session; a sibling agent's own failed record is untouched", async () => {
    const dir = await makeTempDir();
    const AGENT_ID = "@a1";
    const SIBLING = "@sibling";
    const OLD = { shortId: "old00001", sessionId: "old00001-session" };

    let state = emptyAgentStore();
    state = putAgent(state, { id: AGENT_ID, name: "a1", directory: KEY, state: "on", createdAt: 1, birthSessionId: OLD.sessionId, restoreTarget: { ...OLD } });
    state = putAgent(state, { id: SIBLING, name: "sibling", directory: KEY, state: "on", createdAt: 1, birthSessionId: "sib-session", restoreTarget: { sessionId: "sib-session", shortId: "sib-pane" } });
    state = {
      ...state,
      launches: [
        staleRecord(AGENT_ID, "a1-stale", "long-gone-pane", "respawn refused: TOCTOU re-check reported \"alive\""),
        staleRecord(SIBLING, "sibling-stale", "sib-old-pane", "some earlier unrelated refusal"),
      ],
    };
    await saveAgents(join(dir, "agents.json"), state);

    const fake = makeFakeHost();
    fake.addPane({ cwd: KEY, sessionId: OLD.sessionId }); // the agent's CURRENT session, live right now
    const settings = memorySettings();
    const deps: AgentActionDeps = {
      ...actionDeps(dir, fake.runCommand),
      settings,
      launchConfigDeps: { readConfigFile: async () => RELAUNCH_MCP, settingsIo: settings },
      transcriptProbeDeps: { listProjectDirs: async () => ({ ok: true, dirs: ["-claimed-dir"] }), transcriptExistsIn: async () => ({ ok: true, exists: true }) },
      sleep: async () => {},
      isPidAlive: () => false,
      resumeCwdDeps: { lastRecordedCwd: async () => undefined, isDirectory: async () => false },
    } as AgentActionDeps;

    const result = await relaunch(deps, KEY, AGENT_ID);
    expect(result.ok).toBe(true);

    const finalStore = await loadAgents(join(dir, "agents.json"));
    if (finalStore.status !== "loaded") throw new Error("expected loaded store");
    expect(finalStore.state.launches.map((l) => l.attemptId)).toEqual(["sibling-stale"]); // FALSIFIER: without fix 1, "a1-stale" survives a healthy relaunch
  });
});
