// relaunch (fork the session with current MCP access, keep the conversation)
// and delete of an agent whose launch crashed, against a real temp-dir store
// and a fake `claude`. Each test names what it falsifies.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpSettingsIo } from "@brooswit/drovr";
import { beginLaunch, emptyAgentStore, markLaunchStarted, putAgent, type AgentRecord, type AgentStoreState } from "../../src/agent-model";
import { save as saveAgents, load as loadAgents } from "../../src/agent-store-io";
import { deleteAgent, relaunch, type AgentActionDeps } from "../../src/agent-actions";
import type { ClaimKey } from "../../src/claim-key-resolve";
import type { CommandResult, RunCommandOptions } from "../../src/spawn";
import type { TranscriptProbeDeps } from "../../src/transcript-probe";

const KEY = "/claimed/rocketr" as ClaimKey;
const ROCKETR_MCP = JSON.stringify({ mcpServers: { rocketr: { type: "http" }, yappr: { type: "stdio" } } });
const OLD = { shortId: "old00001", sessionId: "old00001-session" };

const cleanup: string[] = [];
afterEach(async () => { while (cleanup.length) await rm(cleanup.pop()!, { recursive: true, force: true }); });

interface Entry { id: string; sessionId: string; cwd: string; startedAt: number; kind: string; pid?: number; state?: string }

/** A fake `claude`: `agents --json` lists running sessions, `--all` adds ended ones, `stop` ends one, `systemd-run … --bg` starts one. */
function fakeClaude(opts: { stopFails?: boolean; launchFails?: boolean; neverLists?: boolean } = {}) {
  const running: Entry[] = [];
  const ended: Entry[] = [];
  const calls: string[][] = [];
  let next = 0;
  async function runCommand(argv: string[], cmd: RunCommandOptions): Promise<CommandResult> {
    calls.push(argv);
    if (argv[0] === "claude" && argv[1] === "agents") {
      return { exitCode: 0, stdout: JSON.stringify(argv.includes("--all") ? [...running, ...ended] : running), stderr: "" };
    }
    if (argv[0] === "claude" && argv[1] === "stop") {
      if (opts.stopFails) return { exitCode: 1, stdout: "", stderr: "stop refused" };
      const i = running.findIndex((s) => s.id === argv[2]);
      if (i >= 0) {
        const { pid: _pid, ...rest } = running.splice(i, 1)[0]!;
        ended.push({ ...rest, state: "stopped" });
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (argv[0] === "systemd-run") {
      if (opts.launchFails) return { exitCode: 1, stdout: "", stderr: "launch refused" };
      const id = `new0000${next++}`;
      if (!opts.neverLists) running.push({ id, sessionId: `${id}-session`, cwd: cmd.cwd ?? "", startedAt: 2, kind: "background", pid: 4242, state: "blocked" });
      return { exitCode: 0, stdout: `backgrounded · ${id} (idle — send a prompt to start)\n`, stderr: "" };
    }
    throw new Error(`unexpected argv ${JSON.stringify(argv)}`);
  }
  return { runCommand, running, ended, calls };
}

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

function deps(dir: string, claude: ReturnType<typeof fakeClaude>, extra: Partial<AgentActionDeps> = {}): AgentActionDeps & { settings: ReturnType<typeof memorySettings> } {
  let n = 0;
  let clock = 1_700_000_000_000;
  const settings = memorySettings();
  return {
    settings,
    agentsPath: join(dir, "agents.json"),
    runCommand: claude.runCommand,
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

describe("relaunch", () => {
  test("forks the running session with every server's channel, and the fork becomes the restore target", async () => {
    const dir = await setup({});
    const claude = fakeClaude();
    claude.running.push({ id: OLD.shortId, sessionId: OLD.sessionId, cwd: KEY, startedAt: 1, kind: "background", pid: 111, state: "blocked" });
    const d = deps(dir, claude);

    const r = await relaunch(d, KEY, "rocketr");
    if (!r.ok) throw new Error(`${r.reason}: ${r.message}`);
    expect(r.forked).toBe(true);
    expect(r.previous).toEqual(OLD);
    expect(r.next).toEqual({ shortId: "new00000", sessionId: "new00000-session" });

    // FALSIFIER: stop first, then a FORK of the old session — never a respawn, never a fresh session.
    const order = claude.calls.filter((c) => c[1] === "stop" || c[0] === "systemd-run").map((c) => c[0] === "systemd-run" ? "launch" : `stop ${c[2]}`);
    expect(order).toEqual([`stop ${OLD.shortId}`, "launch"]);
    const launched = claude.calls.find((c) => c[0] === "systemd-run")!;
    const args = launched.slice(launched.indexOf("claude") + 1, launched.indexOf("--bg"));
    expect(args.slice(0, 3)).toEqual(["--resume", OLD.sessionId, "--fork-session"]);
    // Channels are on for every server the directory configures, with no opt-in.
    expect(args).toContain("--dangerously-load-development-channels=server:rocketr");
    expect(args).toContain("--dangerously-load-development-channels=server:yappr");
    expect(claude.calls.some((c) => c[1] === "respawn")).toBe(false);

    const agent = (await stored(dir)).agents["@rocketr"]!;
    expect(agent.state).toBe("on");
    expect(agent.restoreTarget).toEqual({ shortId: "new00000", sessionId: "new00000-session" });
    expect(agent.birthSessionId).toBe(OLD.sessionId);
    expect((await stored(dir)).launches).toEqual([]);
  });

  test("an agent whose session was never prompted gets a fresh launch, reported as not forked", async () => {
    const dir = await setup({});
    const claude = fakeClaude();
    const r = await relaunch(deps(dir, claude, { transcriptProbeDeps: transcripts(false) }), KEY, "rocketr");
    if (!r.ok) throw new Error(r.message);
    expect(r.forked).toBe(false);
    const launched = claude.calls.find((c) => c[0] === "systemd-run")!;
    expect(launched).not.toContain("--resume");
  });

  test.each([
    ["off", { state: "off" as const }, "not-on"],
    ["without a session", { restoreTarget: undefined }, "no-session"],
  ])("refuses an agent that is %s, changing nothing", async (_label, agent, reason) => {
    const dir = await setup(agent);
    const claude = fakeClaude();
    const before = await stored(dir);
    const r = await relaunch(deps(dir, claude), KEY, "rocketr");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason as string).toBe(reason);
    expect(await stored(dir)).toEqual(before);
    expect(claude.calls.some((c) => c[1] === "stop" || c[0] === "systemd-run")).toBe(false);
  });

  test("refuses to relaunch the session running the command", async () => {
    const dir = await setup({});
    const claude = fakeClaude();
    const r = await relaunch(deps(dir, claude), KEY, "rocketr", { selfSessionId: OLD.sessionId });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("self");
    expect(claude.calls.some((c) => c[1] === "stop")).toBe(false);
  });

  test("refuses a session that is mid-turn", async () => {
    const dir = await setup({});
    const claude = fakeClaude();
    claude.running.push({ id: OLD.shortId, sessionId: OLD.sessionId, cwd: KEY, startedAt: 1, kind: "background", pid: 111, state: "working" });
    const r = await relaunch(deps(dir, claude), KEY, "rocketr");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("busy");
    expect(claude.running).toHaveLength(1);
  });

  test("refuses while another launch for the agent is in flight", async () => {
    const dir = await setup({}, (s) => beginLaunch(s, "@rocketr", KEY, undefined, "inflight", 1));
    const claude = fakeClaude();
    const r = await relaunch(deps(dir, claude), KEY, "rocketr");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("launch-in-flight");
    expect((await stored(dir)).agents["@rocketr"]!.state).toBe("on");
  });

  test("a stop that fails changes nothing: the agent is back on, with no launch recorded", async () => {
    const dir = await setup({});
    const claude = fakeClaude({ stopFails: true });
    claude.running.push({ id: OLD.shortId, sessionId: OLD.sessionId, cwd: KEY, startedAt: 1, kind: "background", pid: 111, state: "blocked" });
    const r = await relaunch(deps(dir, claude), KEY, "rocketr");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("stop-failed");
    const state = await stored(dir);
    expect(state.agents["@rocketr"]!.state).toBe("on");
    expect(state.agents["@rocketr"]!.restoreTarget).toEqual(OLD);
    expect(state.launches).toEqual([]);
  });

  test("a fork that fails leaves the agent off, its old target intact, and says how to recover", async () => {
    const dir = await setup({});
    const claude = fakeClaude({ launchFails: true });
    const r = await relaunch(deps(dir, claude), KEY, "rocketr");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("launch-failed");
    expect(r.message).toContain('"bakr rocketr on"');
    const state = await stored(dir);
    // FALSIFIER: left `on`, a daemon would respawn the old session behind the operator.
    expect(state.agents["@rocketr"]!.state).toBe("off");
    expect(state.agents["@rocketr"]!.restoreTarget).toEqual(OLD);
    expect(state.launches).toEqual([]);
  });

  test("a fork that never lists stays recorded for the daemon to resolve, with the agent off", async () => {
    const dir = await setup({});
    const claude = fakeClaude({ neverLists: true });
    const r = await relaunch(deps(dir, claude), KEY, "rocketr");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("unlisted");
    const state = await stored(dir);
    expect(state.agents["@rocketr"]!.state).toBe("off");
    expect(state.launches.map((l) => [l.launchShortId, l.attemptKey])).toEqual([["new00000", { kind: "forkFrom", sessionId: OLD.sessionId }]]);
  });

  test("the agent stays off for the whole window between stop and resolution", async () => {
    const dir = await setup({});
    const claude = fakeClaude();
    claude.running.push({ id: OLD.shortId, sessionId: OLD.sessionId, cwd: KEY, startedAt: 1, kind: "background", pid: 111, state: "blocked" });
    const seen: string[] = [];
    const watching = { ...claude, runCommand: async (argv: string[], o: RunCommandOptions) => {
      if (argv[1] === "stop" || argv[0] === "systemd-run") seen.push((await stored(dir)).agents["@rocketr"]!.state);
      return claude.runCommand(argv, o);
    } };
    const r = await relaunch(deps(dir, watching), KEY, "rocketr");
    expect(r.ok).toBe(true);
    expect(seen).toEqual(["off", "off"]);
  });
});

describe("delete of an agent whose launch never resolved a session", () => {
  const crashed = (s: AgentStoreState) => markLaunchStarted(beginLaunch(s, "@rocketr", KEY, undefined, "a1", 1), "a1", "1635836c");

  test("a launch claude lists as failed counts as stopped: the agent is deleted, its records with it", async () => {
    const dir = await setup({ restoreTarget: undefined, birthSessionId: undefined, state: "archived" }, crashed);
    const claude = fakeClaude();
    claude.ended.push({ id: "1635836c", sessionId: "1635836c-session", cwd: KEY, startedAt: 1, kind: "background", state: "failed" });
    const r = await deleteAgent(deps(dir, claude), KEY, "rocketr");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe("deleted");
    expect(r.stop).toEqual({ kind: "launches-ended", shortIds: ["1635836c"] });
    const state = await stored(dir);
    expect(state.agents["@rocketr"]).toBeUndefined();
    expect(state.launches).toEqual([]);
  });

  test("a launch still running is stopped by its own recorded id, then the agent is deleted", async () => {
    const dir = await setup({ restoreTarget: undefined, birthSessionId: undefined }, crashed);
    const claude = fakeClaude();
    claude.running.push({ id: "1635836c", sessionId: "1635836c-session", cwd: KEY, startedAt: 1, kind: "background", pid: 5, state: "blocked" });
    const r = await deleteAgent(deps(dir, claude), KEY, "rocketr");
    expect(r.ok && r.kind).toBe("deleted");
    expect(claude.calls.filter((c) => c[1] === "stop")).toEqual([["claude", "stop", "1635836c"]]);
  });

  test("a launch no listing accounts for still parks rather than guessing", async () => {
    const dir = await setup({ restoreTarget: undefined, birthSessionId: undefined }, crashed);
    const r = await deleteAgent(deps(dir, fakeClaude()), KEY, "rocketr");
    expect(r.ok && r.kind).toBe("parked");
    expect((await stored(dir)).agents["@rocketr"]!.state).toBe("archived");
  });

  test("a launch in flight with no id yet still parks", async () => {
    const dir = await setup({ restoreTarget: undefined, birthSessionId: undefined }, (s) => beginLaunch(s, "@rocketr", KEY, undefined, "a1", 1));
    const r = await deleteAgent(deps(dir, fakeClaude()), KEY, "rocketr");
    expect(r.ok && r.kind).toBe("parked");
  });

  test("an agent that never launched at all is deleted", async () => {
    const dir = await setup({ restoreTarget: undefined, birthSessionId: undefined });
    const r = await deleteAgent(deps(dir, fakeClaude()), KEY, "rocketr");
    expect(r.ok && r.kind).toBe("deleted");
  });
});
