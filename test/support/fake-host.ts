// A fake of everything bakr's spawn substrate shells out to: herdr (panes
// hosting interactive claude) and legacy `claude --bg` (listing and stop
// only). Stateful, so a test can launch, list, stop and restore through the
// real substrate code (src/spawn) and assert on what was run.

import type { CommandResult, RunCommandOptions } from "../../src/spawn";

export interface FakePane {
  paneId: string;
  workspaceId: string;
  /** The herdr agent name the pane was started under. */
  name?: string;
  cwd: string;
  sessionId: string;
  /** The claude argv the pane was started with (after `--`). */
  args: string[];
  status: "idle" | "working" | "blocked" | "done";
  pid: number | undefined;
  label: string;
  /** What `herdr agent read` shows for this pane; defaults to the host's `blockedScreen`, else an idle input box. */
  screen?: string;
  /** Every permission-prompt option `herdr agent send-keys` answered on this pane, in order. */
  answered?: string[];
  /** Keys reach the prompt but it stays on screen (drovr's `not-cleared`). */
  stuck?: boolean;
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
  /** The first N `agent start`s find the pane's shell not ready yet, as herdr reports for a fresh workspace. */
  shellNotReadyTimes?: number;
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
  let shellNotReady = opts.shellNotReadyTimes ?? 0;
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
        pane_id: p.paneId, workspace_id: p.workspaceId, agent: "claude", agent_status: p.status, name: p.name ?? null,
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
    if (group === "workspace" && verb === "list") {
      if (failing()) throw new Error("simulated listing failure");
      const seen = new Map<string, string>();
      for (const p of panes) if (!seen.has(p.workspaceId)) seen.set(p.workspaceId, p.label);
      return reply({ type: "workspace_list", workspaces: [...seen].map(([workspace_id, label]) => ({ workspace_id, label })) });
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
      // herdr 0.8.2's own rules, as measured: a valid, server-unique agent name, and a pane at its shell prompt.
      const name = argv[3]!;
      if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) return refuse("invalid_agent_name", "agent name must start with a lowercase letter and contain only lowercase letters, digits, '-' or '_' (1-32 characters)");
      const holder = panes.find((p) => p.name === name && p.paneId !== paneId);
      if (holder) return refuse("agent_name_in_use", `agent name ${name} is already used; candidates: pane_id=${holder.paneId}`);
      if (shellNotReady > 0) {
        shellNotReady -= 1;
        // herdr 0.8.2's own code and text for it, measured 2026-09-18 on a pane whose shell was busy.
        return refuse("agent_pane_busy", `agent target pane ${paneId} is not an available shell`);
      }
      pane.name = name;
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
    if (group === "agent" && verb === "read") return { exitCode: 0, stdout: paneFor(argv[3]!)?.screen ?? opts.blockedScreen ?? "❯ ", stderr: "" };
    if (group === "agent" && verb === "send-keys") {
      const pane = paneFor(argv[3]!);
      if (pane) pressKeys(pane, argv.slice(4));
      return reply({ type: "ok" });
    }
    if (group === "pane" && verb === "process-info") {
      const pane = paneFor(argv[argv.indexOf("--pane") + 1]!);
      if (!pane) return refuse("pane_not_found", "no such pane");
      // `pane_process_info` is herdr 0.8.2's own tag (measured 2026-09-18); drovr's listResidents reads the pid only under it.
      return reply({ type: "pane_process_info", process_info: { foreground_processes: pane.pid === undefined ? [] : [{ pid: pane.pid, name: "claude", argv: ["claude", ...pane.args] }] } });
    }
    throw new Error(`fake host: unexpected herdr argv ${JSON.stringify(argv)}`);
  }

  /**
   * Claude's permission dialog as the keys drive it: up/down move the cursor
   * through the numbered options, enter answers the one under it — recorded
   * in `answered` — and the dialog leaves the screen unless the pane is stuck.
   */
  function pressKeys(pane: FakePane, keys: string[]): void {
    const lines = (pane.screen ?? "").split("\n");
    const question = lines.findIndex((line) => /Do you want to .+\?/.test(line));
    if (question < 0) return;
    const options: string[] = [];
    let cursor = -1;
    for (const line of lines.slice(question + 1)) {
      const m = /^\s*(❯\s*)?\d+\.\s+(.+?)\s*$/.exec(line);
      if (!m) break;
      if (m[1]) cursor = options.length;
      options.push(m[2]!);
    }
    for (const key of keys) {
      if (key === "down") cursor = Math.min(cursor + 1, options.length - 1);
      else if (key === "up") cursor = Math.max(cursor - 1, 0);
      else if (key === "enter") {
        pane.answered = [...(pane.answered ?? []), options[cursor]!];
        if (!pane.stuck) pane.screen = "❯ ";
        return;
      }
    }
  }

  /** Puts a pane into the fake as if an earlier launch had started it; `label` is its workspace's (e.g. `bakr @a1` for one bakr started before drovr hosted it). */
  function addPane(p: { cwd: string; sessionId: string; status?: FakePane["status"]; pid?: number; args?: string[]; screen?: string; stuck?: boolean; label?: string; name?: string }): FakePane {
    workspace += 1;
    const pane: FakePane = { paneId: `w${workspace}:p1`, workspaceId: `w${workspace}`, cwd: p.cwd, sessionId: p.sessionId, args: p.args ?? [], status: p.status ?? "idle", pid: p.pid ?? process.pid, label: p.label ?? "", ...(p.name === undefined ? {} : { name: p.name }), ...(p.screen === undefined ? {} : { screen: p.screen }), ...(p.stuck ? { stuck: true } : {}) };
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

/** Claude's tool-permission dialog as `herdr agent read` shows it (claude 2.1.277, as drovr measured it), the cursor on option `cursor`. */
export function permissionScreen(tool: string, request: readonly string[], options: readonly string[] = ["Yes", "Yes, and always allow access to this directory from this project", "No"], cursor = 0): string {
  return [
    "─".repeat(60),
    ` ${tool}`,
    "",
    ...request.map((line) => `   ${line}`),
    "",
    " Do you want to proceed?",
    ...options.map((option, i) => `${i === cursor ? " ❯" : "  "} ${i + 1}. ${option}`),
    "",
    " Esc to cancel · Tab to amend",
    "",
  ].join("\n");
}
