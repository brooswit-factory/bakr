// BAKR-61, through the daemon's real reconcile cycle against the fake host:
// after the 2026-09-19 reboot herdr's resume_agents_on_restore brought every
// agent back as a bare `claude --resume <id>` — same pane, same session, no
// channel flags — and the daemon adopted each one as healthy while it was
// deaf. An alive agent is now healthy only if its live argv carries the flags
// bakr launches it with; otherwise the daemon relaunches the SAME session with
// them, bounded, and never on an argv it could not read.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpSettingsIo } from "@brooswit/drovr";
import { emptyAgentStore, putAgent, type AgentRecord } from "../../src/agent-model";
import { save as saveAgents, load as loadAgents } from "../../src/agent-store-io";
import { claim, emptyStore } from "../../src/claim-model";
import { save as saveClaims } from "../../src/claim-store-io";
import { initialDaemonState, runReconcileCycle, type DaemonDeps, type DaemonState } from "../../src/daemon";
import type { ClaimKey } from "../../src/claim-key-resolve";
import type { RunCommand } from "../../src/spawn";
import { checkAgentArgv } from "../../src/argv-check";
import { makeFakeHost, type FakeHost } from "../support/fake-host";

const KEY = "/claimed/dir" as ClaimKey;
const SESSION = "2cbb5dc5-3f77-487d-b04c-a4c4c046b13e";
const ROCKETR_MCP = JSON.stringify({ mcpServers: { rocketr: { type: "http", url: "http://127.0.0.1:8790/mcp" } } });
/** The flags bakr launches an agent in KEY with, given ROCKETR_MCP. */
const EXPECTED = ["--mcp-config", join(KEY, ".mcp.json"), "--settings", '{"enabledMcpjsonServers":["rocketr"]}', "--dangerously-load-development-channels=server:rocketr"];

const cleanup: string[] = [];
afterEach(async () => { while (cleanup.length) await rm(cleanup.pop()!, { recursive: true, force: true }); });

async function setup(paneId: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bakr-argv-"));
  cleanup.push(dir);
  const record: AgentRecord = { id: "@a1", name: "minecraft", directory: KEY, state: "on", createdAt: 1, birthSessionId: SESSION, restoreTarget: { shortId: paneId, sessionId: SESSION } };
  await saveAgents(join(dir, "agents.json"), putAgent(emptyAgentStore(), record));
  await saveClaims(join(dir, "claims.json"), claim(emptyStore(), KEY, 1).state);
  return dir;
}

function deps(dir: string, runCommand: RunCommand): DaemonDeps {
  let n = 0;
  let clock = 1_700_000_000_000;
  const files: Record<string, string> = {};
  const settingsIo: McpSettingsIo = { readSettings: async (p) => files[p], writeSettings: async (p, c) => { files[p] = c; } };
  return {
    runCommand,
    claimsPath: join(dir, "claims.json"),
    agentsPath: join(dir, "agents.json"),
    sessionSlotsPath: join(dir, "session-slots.json"),
    now: () => clock,
    generateAttemptId: () => `attempt-${n++}`,
    randomBytes: (k) => new Uint8Array(k).fill(1),
    probeDeps: { stat: async () => ({ dev: 1, ino: 1, isDirectory: () => true }) },
    launchConfigDeps: { readConfigFile: async (p) => p === join(KEY, ".mcp.json") ? ROCKETR_MCP : undefined, settingsIo },
    transcriptProbeDeps: { listProjectDirs: async () => ({ ok: true, dirs: ["-claimed-dir"] }), transcriptExistsIn: async () => ({ ok: true, exists: true }) },
    resumeCwdDeps: { lastRecordedCwd: async () => undefined, isDirectory: async () => false },
    relaunch: { sleep: async (ms) => { clock += ms; }, isPidAlive: () => false },
  };
}

const holding = (host: FakeHost) => host.panes.filter((p) => p.sessionId === SESSION);

async function agentNow(dir: string): Promise<AgentRecord> {
  const loaded = await loadAgents(join(dir, "agents.json"));
  if (loaded.status !== "loaded") throw new Error("store not loaded");
  return loaded.state.agents["@a1"]!;
}

async function cycles(d: DaemonDeps, count: number, from: DaemonState = initialDaemonState()): Promise<DaemonState> {
  let state = from;
  for (let i = 0; i < count; i++) {
    const r = await runReconcileCycle(state, d);
    state = { claimDegraded: r.claimDegraded, agentsDegraded: r.agentsDegraded, orphanReportSignatures: r.orphanReportSignatures, isFirstCycle: r.isFirstCycle ?? false, ...(r.argvRelaunches === undefined ? {} : { argvRelaunches: r.argvRelaunches }) };
  }
  return state;
}

describe("the daemon's argv check (BAKR-61)", () => {
  test("a bare `claude --resume <id>` in the agent's own pane is relaunched on the SAME session with its flags: 0 bare, 0 duplicates", async () => {
    const host = makeFakeHost();
    const bare = host.addPane({ cwd: KEY, sessionId: SESSION, args: ["--resume", SESSION] });
    const dir = await setup(bare.paneId);
    const d = deps(dir, host.runCommand);

    const after = await cycles(d, 1);

    // FALSIFIER: without the argv check the bare pane is adopted as `alive` — nothing is stopped or started, and the agent stays deaf.
    expect(host.stops()).toEqual([bare.workspaceId]);
    expect(host.starts()).toHaveLength(1);
    expect(host.starts()[0]!.slice(0, 2)).toEqual(["--resume", SESSION]);
    const panes = holding(host);
    expect(panes).toHaveLength(1);
    expect(checkAgentArgv(EXPECTED, ["claude", ...panes[0]!.args], SESSION)).toEqual({ ok: true });
    expect(panes[0]!.args).toContain("--dangerously-load-development-channels=server:rocketr");
    expect(panes[0]!.args).not.toContain("bypassPermissions");
    const agent = await agentNow(dir);
    expect(agent.state).toBe("on");
    expect(agent.restoreTarget).toEqual({ shortId: panes[0]!.paneId, sessionId: SESSION });
    expect(after.argvRelaunches).toEqual({ "@a1": 1 });

    // The next cycle finds the argv right: nothing more is stopped or started, and the count drops out.
    const settled = await cycles(d, 1, after);
    expect(host.stops()).toHaveLength(1);
    expect(host.starts()).toHaveLength(1);
    expect(settled.argvRelaunches).toEqual({});
  });

  test("an agent already running with its flags is left alone", async () => {
    const host = makeFakeHost();
    const pane = host.addPane({ cwd: KEY, sessionId: SESSION, args: ["--resume", SESSION, ...EXPECTED] });
    const dir = await setup(pane.paneId);
    const state = await cycles(deps(dir, host.runCommand), 2);
    expect(host.stops()).toEqual([]);
    expect(host.starts()).toEqual([]);
    expect(state.argvRelaunches).toEqual({});
  });

  // FALSIFIER: an argv read that fails must be "couldn't check" — treating it as a mismatch relaunches a healthy agent.
  test("an argv that cannot be read is never a mismatch: no relaunch", async () => {
    const host = makeFakeHost();
    const pane = host.addPane({ cwd: KEY, sessionId: SESSION, args: ["--resume", SESSION] });
    const dir = await setup(pane.paneId);
    // The listing's own process-info (for the pid) succeeds; every later one — the argv read — fails.
    let reads = 0;
    const flaky: RunCommand = async (argv, opts) => {
      if (argv[1] === "pane" && argv[2] === "process-info" && reads++ >= 1) return { exitCode: 1, stdout: JSON.stringify({ error: { code: "boom", message: "process-info failed" } }), stderr: "" };
      return host.runCommand(argv, opts);
    };
    await cycles(deps(dir, flaky), 1);
    expect(reads).toBeGreaterThanOrEqual(2); // the argv read was attempted, and failed
    expect(host.stops()).toEqual([]);
    expect(host.starts()).toEqual([]);
  });

  test("a mid-turn agent is not relaunched (its typed input would be cut off) and the attempt is not counted", async () => {
    const host = makeFakeHost();
    const pane = host.addPane({ cwd: KEY, sessionId: SESSION, args: ["--resume", SESSION], status: "working" });
    const dir = await setup(pane.paneId);
    const state = await cycles(deps(dir, host.runCommand), 2);
    expect(host.stops()).toEqual([]);
    expect(host.starts()).toEqual([]);
    expect(state.argvRelaunches).toEqual({});
  });

  test("bounded: a relaunch that keeps coming back bare is retried at most twice in a row, then left for an operator", async () => {
    const host = makeFakeHost();
    const pane = host.addPane({ cwd: KEY, sessionId: SESSION, args: ["--resume", SESSION] });
    const dir = await setup(pane.paneId);
    // Every start comes up bare, as if something below bakr kept dropping the flags.
    const stripping: RunCommand = async (argv, opts) =>
      host.runCommand(argv[1] === "agent" && argv[2] === "start" ? [...argv.slice(0, argv.indexOf("--") + 1), "--resume", SESSION] : argv, opts);
    const state = await cycles(deps(dir, stripping), 5);
    // FALSIFIER: without the bound, every cycle kills and restarts the session — five cycles, five stops.
    expect(host.stops()).toHaveLength(2);
    expect(state.argvRelaunches).toEqual({ "@a1": 3 });
    expect(holding(host)).toHaveLength(1);
    expect((await agentNow(dir)).state).toBe("on");
  });
});
