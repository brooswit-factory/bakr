// BAKR-37, through the real callers: the panes bakr started before drovr
// hosted them (workspace `bakr <id>`, agent name `bakr-<id>-<ws>`) are
// adopted by `off`, `relaunch` and the daemon's restore decision exactly as
// before the swap — found by session id, closed by their own workspace, never
// restored a second time — and a relaunch moves the agent onto drovr's host.
// Each test names what it falsifies.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpSettingsIo } from "@brooswit/drovr";
import { emptyAgentStore, putAgent, type AgentRecord } from "../../src/agent-model";
import { save as saveAgents, load as loadAgents } from "../../src/agent-store-io";
import { off, relaunch, type AgentActionDeps } from "../../src/agent-actions";
import { decideAndBeginForAgent, type DaemonDeps } from "../../src/daemon";
import type { ClaimKey } from "../../src/claim-key-resolve";
import { listBackgroundSessions } from "../../src/spawn";
import { makeFakeHost, type FakeHost } from "../support/fake-host";

const KEY = "/claimed/rocketr" as ClaimKey;
const SESSION = "rocketr-session";

const cleanup: string[] = [];
afterEach(async () => { while (cleanup.length) await rm(cleanup.pop()!, { recursive: true, force: true }); });

/** A live pane exactly as bakr's own host left it before BAKR-37. */
const legacyPane = (host: FakeHost, sessionId = SESSION) =>
  host.addPane({ cwd: KEY, sessionId, label: "bakr @rocketr", name: "bakr-rocketr-w1" });

async function setup(restoreShortId: string) {
  const dir = await mkdtemp(join(tmpdir(), "bakr-adoption-"));
  cleanup.push(dir);
  const record: AgentRecord = {
    id: "@rocketr", name: "rocketr", directory: KEY, state: "on", createdAt: 1,
    birthSessionId: SESSION, restoreTarget: { shortId: restoreShortId, sessionId: SESSION },
  };
  await saveAgents(join(dir, "agents.json"), putAgent(emptyAgentStore(), record));
  return dir;
}

function actionDeps(dir: string, host: FakeHost): AgentActionDeps {
  let n = 0;
  let clock = 1_700_000_000_000;
  const files: Record<string, string> = {};
  const settingsIo: McpSettingsIo = { readSettings: async (p) => files[p], writeSettings: async (p, c) => { files[p] = c; } };
  return {
    agentsPath: join(dir, "agents.json"),
    runCommand: host.runCommand,
    now: () => clock,
    generateAttemptId: () => `attempt-${n++}`,
    randomBytes: (k) => new Uint8Array(k),
    launchConfigDeps: { readConfigFile: async () => undefined, settingsIo },
    transcriptProbeDeps: { listProjectDirs: async () => ({ ok: true, dirs: ["-claimed-rocketr"] }), transcriptExistsIn: async () => ({ ok: true, exists: true }) },
    sleep: async (ms) => { clock += ms; },
    isPidAlive: () => false,
    resumeCwdDeps: { lastRecordedCwd: async () => undefined, isDirectory: async () => false },
  };
}

describe("off and relaunch on a pane bakr started before drovr hosted it", () => {
  test("off closes the legacy pane's own workspace, found by its session id, and nothing else", async () => {
    const host = makeFakeHost();
    const bystander = legacyPane(host, "someone-else");
    const pane = legacyPane(host);
    const dir = await setup(pane.paneId);
    const r = await off(actionDeps(dir, host), { kind: "id", ref: "@rocketr" });
    // FALSIFIER: a listing of drovr's residents alone finds no pane for SESSION, and off reports `already-gone` with the pane still running.
    if (!r.ok || r.kind !== "turned-off") throw new Error(JSON.stringify(r));
    expect(r.stop).toEqual({ kind: "stopped", shortId: pane.paneId });
    expect(host.stops()).toEqual([pane.workspaceId]);
    expect(host.panes.map((p) => p.paneId)).toEqual([bystander.paneId]);
  });

  test("relaunch closes the legacy pane and resumes the SAME session on drovr's host: exactly one pane for it, in a `drovr ` workspace", async () => {
    const host = makeFakeHost();
    const pane = legacyPane(host);
    const dir = await setup(pane.paneId);
    const r = await relaunch(actionDeps(dir, host), { kind: "id", ref: "@rocketr" });
    if (!r.ok) throw new Error(`${r.reason}: ${r.message}`);
    expect(r.resumed).toBe(true);
    expect(host.stops()).toEqual([pane.workspaceId]);
    expect(host.starts().map((a) => a.slice(0, 2))).toEqual([["--resume", SESSION]]);
    const holding = host.panes.filter((p) => p.sessionId === SESSION);
    // FALSIFIER: a relaunch that did not close the legacy pane leaves two panes running one session.
    expect(holding).toHaveLength(1);
    expect(holding[0]!.label).toBe("drovr bakr-rocketr");
    expect(holding[0]!.name).toBe("bakr-rocketr");
    const loaded = await loadAgents(join(dir, "agents.json"));
    if (loaded.status !== "loaded") throw new Error("store not loaded");
    expect(loaded.state.agents["@rocketr"]!.restoreTarget).toEqual({ shortId: holding[0]!.paneId, sessionId: SESSION });
  });
});

describe("the daemon's double-restore guard, kept until DROVR-13", () => {
  function daemonDeps(dir: string, host: FakeHost): DaemonDeps {
    let n = 0;
    return {
      runCommand: host.runCommand,
      claimsPath: join(dir, "claims.json"),
      agentsPath: join(dir, "agents.json"),
      sessionSlotsPath: join(dir, "session-slots.json"),
      now: () => 1_700_000_000_000,
      generateAttemptId: () => `attempt-${n++}`,
      randomBytes: (k: number) => new Uint8Array(k).fill(1),
      probeDeps: { stat: async () => ({ dev: 1, ino: 1, isDirectory: () => true }) },
    };
  }

  test.each([
    ["a legacy `bakr ` pane", "bakr @rocketr"],
    ["a pane in a workspace nobody here started", "someone's own workspace"],
  ])("a session alive in %s is never restored, even when the store names a stale pane", async (_label, label) => {
    const host = makeFakeHost();
    host.addPane({ cwd: KEY, sessionId: SESSION, label });
    const dir = await setup("w99:p1");
    const sessions = await listBackgroundSessions({ runCommand: host.runCommand });
    const outcome = await decideAndBeginForAgent(daemonDeps(dir, host), "@rocketr", KEY, sessions);
    // FALSIFIER: listing only drovr's residents misses this pane, the decision is `begin-respawn`, and one session runs in two panes.
    expect(outcome.decision?.kind).toBe("alive");
  });
});
