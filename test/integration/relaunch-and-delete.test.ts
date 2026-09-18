// relaunch (resume the SAME session in a new herdr pane with current MCP
// access, keeping the conversation) and delete of an agent whose launch
// crashed, against a real temp-dir store and the shared fake host (herdr plus
// legacy `claude --bg`). Each test names what it falsifies.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpSettingsIo } from "@brooswit/drovr";
import { beginLaunch, emptyAgentStore, markLaunchStarted, putAgent, type AgentRecord, type AgentStoreState } from "../../src/agent-model";
import { save as saveAgents, load as loadAgents } from "../../src/agent-store-io";
import { deleteAgent, relaunch, type AgentActionDeps } from "../../src/agent-actions";
import type { ClaimKey } from "../../src/claim-key-resolve";
import type { RunCommandOptions } from "../../src/spawn";
import type { TranscriptProbeDeps } from "../../src/transcript-probe";
import { makeFakeHost, type FakeHost } from "../support/fake-host";

const KEY = "/claimed/rocketr" as ClaimKey;
const ROCKETR_MCP = JSON.stringify({ mcpServers: { rocketr: { type: "http" }, yappr: { type: "stdio" } } });
/** A session recorded before bakr moved to herdr: its handle is a legacy `claude --bg` short id. */
const OLD = { shortId: "old00001", sessionId: "old00001-session" };

const cleanup: string[] = [];
afterEach(async () => { while (cleanup.length) await rm(cleanup.pop()!, { recursive: true, force: true }); });

/** The legacy background session behind OLD, still running. */
const legacyOld = (host: FakeHost, state = "blocked") =>
  host.legacy.push({ id: OLD.shortId, sessionId: OLD.sessionId, cwd: KEY, startedAt: 1, kind: "background", pid: 111, state });

function memorySettings(): McpSettingsIo & { files: Record<string, string> } {
  const files: Record<string, string> = {};
  return { files, readSettings: async (p) => files[p], writeSettings: async (p, c) => { files[p] = c; } };
}

const transcripts = (has: boolean): TranscriptProbeDeps => ({
  listProjectDirs: async () => ({ ok: true, dirs: ["-claimed-rocketr"] }),
  transcriptExistsIn: async () => ({ ok: true, exists: has }),
});

async function setup(agent: Partial<AgentRecord>, state: (s: AgentStoreState) => AgentStoreState = (s) => s) {
  const dir = await mkdtemp(join(tmpdir(), "bakr-relaunch-"));
  cleanup.push(dir);
  const record: AgentRecord = {
    id: "@rocketr", name: "rocketr", directory: KEY, state: "on", createdAt: 1,
    birthSessionId: OLD.sessionId, restoreTarget: { ...OLD }, ...agent,
  };
  await saveAgents(join(dir, "agents.json"), state(putAgent(emptyAgentStore(), record)));
  return dir;
}

function deps(dir: string, host: Pick<FakeHost, "runCommand">, extra: Partial<AgentActionDeps> = {}): AgentActionDeps & { settings: ReturnType<typeof memorySettings> } {
  let n = 0;
  let clock = 1_700_000_000_000;
  const settings = memorySettings();
  return {
    settings,
    agentsPath: join(dir, "agents.json"),
    runCommand: host.runCommand,
    now: () => clock,
    generateAttemptId: () => `attempt-${n++}`,
    randomBytes: (k) => new Uint8Array(k),
    launchConfigDeps: { readConfigFile: async () => ROCKETR_MCP, settingsIo: settings },
    transcriptProbeDeps: transcripts(true),
    sleep: async (ms) => { clock += ms; },
    isPidAlive: () => false,
    ...extra,
  };
}

const stored = async (dir: string) => {
  const loaded = await loadAgents(join(dir, "agents.json"));
  if (loaded.status !== "loaded") throw new Error("store not loaded");
  return loaded.state;
};

/** Stops and starts, in order: `stop <id>` for a workspace close / `claude stop`, `start` for a `herdr agent start`. */
const stopsAndStarts = (host: FakeHost): string[] =>
  host.calls.flatMap((c) =>
    c[0] === "herdr" && c[1] === "agent" && c[2] === "start" ? ["start"]
      : (c[0] === "herdr" && c[1] === "workspace" && c[2] === "close") || (c[0] === "claude" && c[1] === "stop") ? [`stop ${c[c.length - 1]}`]
        : []);

describe("relaunch", () => {
  test("moves a legacy background session into a herdr pane: stops it, resumes the SAME session with every server's channel, and the new pane becomes the restore target", async () => {
    const dir = await setup({});
    const host = makeFakeHost();
    legacyOld(host);
    const d = deps(dir, host);

    const r = await relaunch(d, KEY, "rocketr");
    if (!r.ok) throw new Error(`${r.reason}: ${r.message}`);
    expect(r.resumed).toBe(true);
    expect(r.previous).toEqual(OLD);
    expect(r.next).toEqual({ shortId: "w1:p1", sessionId: OLD.sessionId });

    // FALSIFIER: stop first (the legacy session by its own short id), then a RESUME of the old session — never a fork, never a fresh session.
    expect(stopsAndStarts(host)).toEqual([`stop ${OLD.shortId}`, "start"]);
    const args = host.starts()[0]!;
    expect(args.slice(0, 2)).toEqual(["--resume", OLD.sessionId]);
    expect(args).not.toContain("--fork-session");
    expect(args).not.toContain("--session-id");
    // Channels are on for every server the directory configures, with no opt-in.
    expect(args).toContain("--dangerously-load-development-channels=server:rocketr");
    expect(args).toContain("--dangerously-load-development-channels=server:yappr");
    expect(r.args).toEqual(args);

    const agent = (await stored(dir)).agents["@rocketr"]!;
    expect(agent.state).toBe("on");
    expect(agent.restoreTarget).toEqual({ shortId: "w1:p1", sessionId: OLD.sessionId });
    expect(agent.birthSessionId).toBe(OLD.sessionId);
    expect((await stored(dir)).launches).toEqual([]);
    expect(host.legacy).toEqual([]);
    expect(host.panes.map((p) => [p.paneId, p.sessionId])).toEqual([["w1:p1", OLD.sessionId]]);
  });

  test("relaunching a session already in a pane closes that pane's workspace and resumes it in a new one — and a relaunch of the relaunch still carries the conversation", async () => {
    const dir = await setup({});
    const host = makeFakeHost();
    legacyOld(host);

    const first = await relaunch(deps(dir, host), KEY, "rocketr");
    if (!first.ok) throw new Error(`${first.reason}: ${first.message}`);
    const second = await relaunch(deps(dir, host), KEY, "rocketr");
    if (!second.ok) throw new Error(`${second.reason}: ${second.message}`);

    // FALSIFIER: a fork would have minted a new session id each time; the session id never changes, only the pane.
    expect(second.resumed).toBe(true);
    expect(second.previous).toEqual({ shortId: "w1:p1", sessionId: OLD.sessionId });
    expect(second.next).toEqual({ shortId: "w2:p1", sessionId: OLD.sessionId });
    expect(stopsAndStarts(host)).toEqual([`stop ${OLD.shortId}`, "start", "stop w1", "start"]);
    expect(host.starts().map((a) => a.slice(0, 2))).toEqual([["--resume", OLD.sessionId], ["--resume", OLD.sessionId]]);
    expect(host.panes.map((p) => p.paneId)).toEqual(["w2:p1"]);
    expect((await stored(dir)).agents["@rocketr"]!.restoreTarget).toEqual({ shortId: "w2:p1", sessionId: OLD.sessionId });
  });

  test("an agent whose session was never prompted gets a fresh launch, reported as not resumed", async () => {
    const dir = await setup({});
    const host = makeFakeHost();
    const r = await relaunch(deps(dir, host, { transcriptProbeDeps: transcripts(false) }), KEY, "rocketr");
    if (!r.ok) throw new Error(r.message);
    expect(r.resumed).toBe(false);
    const args = host.starts()[0]!;
    expect(args).not.toContain("--resume");
    // The fresh launch names its own session, and that session becomes the restore target.
    expect(args[0]).toBe("--session-id");
    expect(r.next).toEqual({ shortId: "w1:p1", sessionId: args[1]! });
    expect(r.next.sessionId).not.toBe(OLD.sessionId);
    expect((await stored(dir)).agents["@rocketr"]!.restoreTarget).toEqual(r.next);
  });

  test.each([
    ["off", { state: "off" as const }, "not-on"],
    ["without a session", { restoreTarget: undefined }, "no-session"],
  ])("refuses an agent that is %s, changing nothing", async (_label, agent, reason) => {
    const dir = await setup(agent);
    const host = makeFakeHost();
    const before = await stored(dir);
    const r = await relaunch(deps(dir, host), KEY, "rocketr");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason as string).toBe(reason);
    expect(await stored(dir)).toEqual(before);
    expect(stopsAndStarts(host)).toEqual([]);
  });

  test("refuses to relaunch the session running the command", async () => {
    const dir = await setup({});
    const host = makeFakeHost();
    host.addPane({ cwd: KEY, sessionId: OLD.sessionId });
    const r = await relaunch(deps(dir, host), KEY, "rocketr", { selfSessionId: OLD.sessionId });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("self");
    expect(host.stops()).toEqual([]);
  });

  test("refuses a session that is mid-turn", async () => {
    const dir = await setup({});
    const host = makeFakeHost();
    host.addPane({ cwd: KEY, sessionId: OLD.sessionId, status: "working" });
    const r = await relaunch(deps(dir, host), KEY, "rocketr");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("busy");
    expect(host.panes).toHaveLength(1);
    expect(stopsAndStarts(host)).toEqual([]);
  });

  test("refuses while another launch for the agent is in flight", async () => {
    const dir = await setup({}, (s) => beginLaunch(s, "@rocketr", KEY, undefined, "inflight", 1));
    const host = makeFakeHost();
    const r = await relaunch(deps(dir, host), KEY, "rocketr");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("launch-in-flight");
    expect((await stored(dir)).agents["@rocketr"]!.state).toBe("on");
  });

  test("a stop that fails changes nothing: the agent is back on, with no launch recorded", async () => {
    const dir = await setup({});
    const host = makeFakeHost({ failStop: true });
    host.addPane({ cwd: KEY, sessionId: OLD.sessionId });
    const r = await relaunch(deps(dir, host), KEY, "rocketr");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("stop-failed");
    const state = await stored(dir);
    expect(state.agents["@rocketr"]!.state).toBe("on");
    expect(state.agents["@rocketr"]!.restoreTarget).toEqual(OLD);
    expect(state.launches).toEqual([]);
    expect(host.starts()).toEqual([]);
  });

  test("a resume that fails leaves the agent off, its old target intact, no half-started pane, and says how to recover", async () => {
    const dir = await setup({});
    const host = makeFakeHost({ failStart: "launch refused" });
    const r = await relaunch(deps(dir, host), KEY, "rocketr");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("launch-failed");
    expect(r.message).toContain("launch refused");
    expect(r.message).toContain('"bakr rocketr on"');
    const state = await stored(dir);
    // FALSIFIER: left `on`, a daemon would restore the old session behind the operator.
    expect(state.agents["@rocketr"]!.state).toBe("off");
    expect(state.agents["@rocketr"]!.restoreTarget).toEqual(OLD);
    expect(state.launches).toEqual([]);
    expect(host.panes).toEqual([]); // the workspace the failed start was given is closed again
  });

  test("the agent stays off for the whole window between stop and resolution", async () => {
    const dir = await setup({});
    const host = makeFakeHost();
    host.addPane({ cwd: KEY, sessionId: OLD.sessionId });
    const seen: string[] = [];
    const watching = { runCommand: async (argv: string[], o: RunCommandOptions) => {
      const isStop = argv[0] === "herdr" && argv[1] === "workspace" && argv[2] === "close";
      const isStart = argv[0] === "herdr" && argv[1] === "agent" && argv[2] === "start";
      if (isStop || isStart) seen.push((await stored(dir)).agents["@rocketr"]!.state);
      return host.runCommand(argv, o);
    } };
    const r = await relaunch(deps(dir, watching), KEY, "rocketr");
    expect(r.ok).toBe(true);
    expect(seen).toEqual(["off", "off"]);
    expect((await stored(dir)).agents["@rocketr"]!.state).toBe("on");
  });
});

describe("delete of an agent whose launch never resolved a session", () => {
  const crashed = (id: string) => (s: AgentStoreState) => markLaunchStarted(beginLaunch(s, "@rocketr", KEY, undefined, "a1", 1), "a1", id);

  test("a legacy launch claude lists as failed counts as stopped: the agent is deleted, its records with it", async () => {
    const dir = await setup({ restoreTarget: undefined, birthSessionId: undefined, state: "archived" }, crashed("1635836c"));
    const host = makeFakeHost();
    host.ended.push({ id: "1635836c", sessionId: "1635836c-session", cwd: KEY, startedAt: 1, kind: "background", state: "failed" });
    const r = await deleteAgent(deps(dir, host), KEY, "rocketr");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe("deleted");
    expect(r.stop).toEqual({ kind: "launches-ended", shortIds: ["1635836c"] });
    const state = await stored(dir);
    expect(state.agents["@rocketr"]).toBeUndefined();
    expect(state.launches).toEqual([]);
  });

  test("a legacy launch still running is stopped by its own recorded id, then the agent is deleted", async () => {
    const dir = await setup({ restoreTarget: undefined, birthSessionId: undefined }, crashed("1635836c"));
    const host = makeFakeHost();
    host.legacy.push({ id: "1635836c", sessionId: "1635836c-session", cwd: KEY, startedAt: 1, kind: "background", pid: 5, state: "blocked" });
    const r = await deleteAgent(deps(dir, host), KEY, "rocketr");
    expect(r.ok && r.kind).toBe("deleted");
    expect(host.calls.filter((c) => c[0] === "claude" && c[1] === "stop")).toEqual([["claude", "stop", "1635836c"]]);
  });

  test("a launch still running in a herdr pane is stopped by closing that pane's workspace, then the agent is deleted", async () => {
    const host = makeFakeHost();
    const pane = host.addPane({ cwd: KEY, sessionId: "crashed-session" });
    const dir = await setup({ restoreTarget: undefined, birthSessionId: undefined }, crashed(pane.paneId));
    const r = await deleteAgent(deps(dir, host), KEY, "rocketr");
    expect(r.ok && r.kind).toBe("deleted");
    expect(host.stops()).toEqual([pane.workspaceId]);
    expect(host.panes).toEqual([]);
  });

  test("a pane launch whose pane is gone has ended — herdr lists only live panes — so the agent is deleted, not parked forever", async () => {
    const dir = await setup({ restoreTarget: undefined, birthSessionId: undefined, state: "archived" }, crashed("w7:p1"));
    const host = makeFakeHost();
    const r = await deleteAgent(deps(dir, host), KEY, "rocketr");
    expect(r.ok && r.kind).toBe("deleted");
    if (r.ok) expect(r.stop).toEqual({ kind: "launches-ended", shortIds: ["w7:p1"] });
    expect(host.stops()).toEqual([]);
  });

  test("a legacy launch no listing accounts for still parks rather than guessing", async () => {
    const dir = await setup({ restoreTarget: undefined, birthSessionId: undefined }, crashed("1635836c"));
    const r = await deleteAgent(deps(dir, makeFakeHost()), KEY, "rocketr");
    expect(r.ok && r.kind).toBe("parked");
    expect((await stored(dir)).agents["@rocketr"]!.state).toBe("archived");
  });

  test("a launch in flight with no id yet still parks", async () => {
    const dir = await setup({ restoreTarget: undefined, birthSessionId: undefined }, (s) => beginLaunch(s, "@rocketr", KEY, undefined, "a1", 1));
    const r = await deleteAgent(deps(dir, makeFakeHost()), KEY, "rocketr");
    expect(r.ok && r.kind).toBe("parked");
  });

  test("an agent that never launched at all is deleted", async () => {
    const dir = await setup({ restoreTarget: undefined, birthSessionId: undefined });
    const r = await deleteAgent(deps(dir, makeFakeHost()), KEY, "rocketr");
    expect(r.ok && r.kind).toBe("deleted");
  });
});
