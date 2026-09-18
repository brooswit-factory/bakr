// A fake of everything bakr's spawn substrate shells out to: herdr (panes
// hosting interactive claude) and legacy `claude --bg` (listing and stop
// only). Stateful, so a test can launch, list, stop and restore through the
// real substrate code (src/spawn) and assert on what was run.

import type { CommandResult, RunCommandOptions } from "../../src/spawn";

export interface FakePane {
  paneId: string;
  workspaceId: string;
  cwd: string;
  sessionId: string;
  /** The claude argv the pane was started with (after `--`). */
  args: string[];
  status: "idle" | "working" | "blocked" | "done";
  pid: number | undefined;
  label: string;
}

export interface FakeLegacySession {
  id: string;
  sessionId: string;
  cwd: string;
  startedAt: number;
  kind: string;
  pid?: number;
  state?: string;
}

export interface FakeHostOptions {
  /** Every listing (herdr and claude) throws. */
  failListing?: boolean | (() => boolean);
  /** `herdr agent start` fails with this message. */
  failStart?: string;
  /** Closing a workspace / `claude stop` fails. */
  failStop?: boolean;
  /** A started pane stays blocked on this screen text (e.g. an unknown prompt). */
  blockedScreen?: string;
  /** A pane's claude pid; defaults to this test process's pid, so it verifies alive. */
  pidFor?: (paneId: string) => number | undefined;
  /** Mints session ids for fresh launches and forks. */
  mintSessionId?: () => string;
}

const reply = (result: unknown): CommandResult => ({ exitCode: 0, stdout: JSON.stringify({ result }), stderr: "" });
const refuse = (code: string, message: string): CommandResult => ({ exitCode: 1, stdout: JSON.stringify({ error: { code, message } }), stderr: "" });

export function makeFakeHost(opts: FakeHostOptions = {}) {
  const panes: FakePane[] = [];
  const legacy: FakeLegacySession[] = [];
  const ended: FakeLegacySession[] = [];
  const calls: string[][] = [];
  let workspace = 0;
  let minted = 0;
  const mint = opts.mintSessionId ?? (() => `session-${minted++}`);
  const failing = () => typeof opts.failListing === "function" ? opts.failListing() : opts.failListing === true;

  function paneFor(id: string): FakePane | undefined {
    return panes.find((p) => p.paneId === id);
  }

  async function runCommand(argv: string[], _cmd: RunCommandOptions): Promise<CommandResult> {
    calls.push(argv);
    const [bin, group, verb] = argv;
    if (bin === "claude" && group === "agents") {
      if (failing()) throw new Error("simulated listing failure");
      return { exitCode: 0, stdout: JSON.stringify(argv.includes("--all") ? [...legacy, ...ended] : legacy), stderr: "" };
    }
    if (bin === "claude" && group === "stop") {
      if (opts.failStop) return { exitCode: 1, stdout: "", stderr: "stop refused" };
      const i = legacy.findIndex((s) => s.id === argv[2]);
      if (i >= 0) {
        const { pid: _pid, ...rest } = legacy.splice(i, 1)[0]!;
        ended.push({ ...rest, state: "stopped" });
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (bin !== "herdr") throw new Error(`fake host: unexpected argv ${JSON.stringify(argv)}`);

    if (group === "agent" && verb === "list") {
      if (failing()) throw new Error("simulated listing failure");
      return reply({ type: "agent_list", agents: panes.map((p) => ({
        pane_id: p.paneId, workspace_id: p.workspaceId, agent: "claude", agent_status: p.status,
        interactive_ready: true, cwd: p.cwd, agent_session: { agent: "claude", kind: "id", value: p.sessionId },
      })) });
    }
    if (group === "workspace" && verb === "create") {
      workspace += 1;
      const cwd = argv[argv.indexOf("--cwd") + 1] ?? "";
      const label = argv[argv.indexOf("--label") + 1] ?? "";
      const paneId = `w${workspace}:p1`;
      panes.push({ paneId, workspaceId: `w${workspace}`, cwd, sessionId: "", args: [], status: "idle", pid: undefined, label });
      return reply({ type: "workspace_created", workspace: { workspace_id: `w${workspace}`, label }, root_pane: { pane_id: paneId, cwd } });
    }
    if (group === "workspace" && verb === "close") {
      if (opts.failStop) return refuse("close_failed", "workspace close refused");
      const id = argv[3];
      for (let i = panes.length - 1; i >= 0; i--) if (panes[i]!.workspaceId === id) panes.splice(i, 1);
      return reply({ type: "ok" });
    }
    if (group === "agent" && verb === "start") {
      const paneId = argv[argv.indexOf("--pane") + 1]!;
      const pane = paneFor(paneId);
      if (!pane) return refuse("pane_not_found", `no pane ${paneId}`);
      if (opts.failStart) return refuse("start_failed", opts.failStart);
      const args = argv.slice(argv.indexOf("--") + 1);
      const resume = args.indexOf("--resume");
      const named = args.indexOf("--session-id");
      pane.args = args;
      pane.sessionId = resume >= 0 && !args.includes("--fork-session") ? args[resume + 1]! : named >= 0 ? args[named + 1]! : mint();
      pane.pid = opts.pidFor ? opts.pidFor(paneId) : process.pid;
      if (opts.blockedScreen !== undefined) {
        pane.status = "blocked";
        return refuse("agent_not_ready", "agent is blocked during startup");
      }
      return reply({ type: "agent_started", agent: { pane_id: paneId } });
    }
    if (group === "agent" && verb === "get") {
      const pane = paneFor(argv[3]!);
      if (!pane) return refuse("agent_not_found", "no such agent");
      return reply({ type: "agent", agent: {
        pane_id: pane.paneId, agent: "claude", agent_status: pane.status, interactive_ready: pane.status !== "blocked",
        cwd: pane.cwd, agent_session: { agent: "claude", kind: "id", value: pane.sessionId },
      } });
    }
    if (group === "agent" && verb === "read") return { exitCode: 0, stdout: opts.blockedScreen ?? "❯ ", stderr: "" };
    if (group === "agent" && verb === "send-keys") return reply({ type: "ok" });
    if (group === "pane" && verb === "process-info") {
      const pane = paneFor(argv[argv.indexOf("--pane") + 1]!);
      if (!pane) return refuse("pane_not_found", "no such pane");
      return reply({ type: "process_info", process_info: { foreground_processes: pane.pid === undefined ? [] : [{ pid: pane.pid, name: "claude", argv: ["claude", ...pane.args] }] } });
    }
    throw new Error(`fake host: unexpected herdr argv ${JSON.stringify(argv)}`);
  }

  /** Puts a pane into the fake as if an earlier launch had started it. */
  function addPane(p: { cwd: string; sessionId: string; status?: FakePane["status"]; pid?: number; args?: string[] }): FakePane {
    workspace += 1;
    const pane: FakePane = { paneId: `w${workspace}:p1`, workspaceId: `w${workspace}`, cwd: p.cwd, sessionId: p.sessionId, args: p.args ?? [], status: p.status ?? "idle", pid: p.pid ?? process.pid, label: "" };
    panes.push(pane);
    return pane;
  }

  /** The claude argv of every `herdr agent start`, in order. */
  const starts = (): string[][] => calls.filter((c) => c[0] === "herdr" && c[1] === "agent" && c[2] === "start").map((c) => c.slice(c.indexOf("--") + 1));
  /** Every stop issued: a workspace close or a legacy `claude stop`. */
  const stops = (): string[] => calls.filter((c) => (c[0] === "herdr" && c[1] === "workspace" && c[2] === "close") || (c[0] === "claude" && c[1] === "stop")).map((c) => c[c.length - 1]!);

  return { runCommand, panes, legacy, ended, calls, addPane, starts, stops };
}

export type FakeHost = ReturnType<typeof makeFakeHost>;
