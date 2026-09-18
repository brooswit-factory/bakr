// The herdr substrate: every session bakr keeps alive runs as an interactive
// Claude Code process in its own herdr workspace pane, never `claude --bg`.
//
// Why: measured on claude 2.1.276, a background session never shows the
// "Loading development channels" confirmation and never delivers a channel
// frame as a turn, while the same session resumed in a terminal pane — the
// confirmation answered — receives yappr and rocketr frames as live turns
// (rocketr agent, session 517fd13a, 2026-09-18). The user's decision: agents
// live in herdr panes, like butchr's. So `launch` creates a workspace, starts
// claude in its root pane, answers the startup prompts a resident cannot, and
// waits for the idle input box; `list` reads herdr's own agent registry; a
// restore is `claude --resume <session>` in a new pane, carrying the agent's
// CURRENT flags every time.
//
// INTERIM: answering startup prompts belongs to drovr (proposed
// `hostResident`). This module keeps the same shape so it can be swapped for
// drovr's host without touching daemon.ts or agent-actions.ts. Every command
// goes through the injected RunCommand, as in the rest of spawn/.

import { randomUUID } from "node:crypto";
import type { RunCommand } from "./exec";
import type { BackgroundSessionInfo } from "./parse";

const HERDR_TIMEOUT_MS = 15_000;
const AGENT_START_TIMEOUT_MS = 60_000;
const READY_TIMEOUT_MS = 90_000;
const READY_POLL_MS = 1_000;

/** The label every bakr-hosted workspace carries, so a listing can tell bakr's panes from anyone else's. */
export const workspaceLabel = (label: string): string => `bakr ${label}`;

export const buildWorkspaceCreateArgv = (cwd: string, label: string): string[] =>
  ["herdr", "workspace", "create", "--cwd", cwd, "--label", workspaceLabel(label), "--no-focus"];

export const buildAgentStartArgv = (paneId: string, claudeArgs: readonly string[]): string[] =>
  ["herdr", "agent", "start", "claude", "--kind", "claude", "--pane", paneId, "--timeout", String(AGENT_START_TIMEOUT_MS), "--", ...claudeArgs];

/**
 * A fresh launch names its own session (`--session-id <uuid>`), so the id is
 * known before claude prints anything; a resume already names one. Leaves any
 * argv that already carries `--resume` or `--session-id` untouched.
 */
export function withSessionId(claudeArgs: readonly string[], mint: () => string = randomUUID): { args: string[]; sessionId: string | undefined } {
  const resume = claudeArgs.indexOf("--resume");
  if (resume >= 0) return { args: [...claudeArgs], sessionId: claudeArgs.includes("--fork-session") ? undefined : claudeArgs[resume + 1] };
  const named = claudeArgs.indexOf("--session-id");
  if (named >= 0) return { args: [...claudeArgs], sessionId: claudeArgs[named + 1] };
  const sessionId = mint();
  return { args: ["--session-id", sessionId, ...claudeArgs], sessionId };
}

type HerdrReply = { ok: true; result: Record<string, unknown> } | { ok: false; code: string; message: string };

/** herdr's CLI prints one JSON object: `{result}` or `{error: {code, message}}`. */
export function parseHerdrReply(stdout: string): HerdrReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ok: false, code: "unparseable", message: `herdr printed something that is not JSON: ${JSON.stringify(stdout.slice(0, 200))}` };
  }
  const value = parsed as { result?: unknown; error?: { code?: unknown; message?: unknown } };
  if (value.error) return { ok: false, code: String(value.error.code ?? "error"), message: String(value.error.message ?? "herdr reported an error") };
  if (value.result && typeof value.result === "object") return { ok: true, result: value.result as Record<string, unknown> };
  return { ok: false, code: "unexpected", message: "herdr printed JSON with neither result nor error" };
}

interface HerdrAgent {
  readonly pane_id: string;
  readonly workspace_id?: string;
  readonly agent?: string;
  readonly agent_status?: string;
  readonly interactive_ready?: boolean;
  readonly cwd?: string;
  readonly agent_session?: { readonly value?: unknown };
}

/** The Claude panes in one `herdr agent list`, with their native session ids. */
export function parseAgentList(result: Record<string, unknown>): HerdrAgent[] {
  const agents = result["agents"];
  if (!Array.isArray(agents)) throw new Error("`herdr agent list` returned no agents array");
  return agents.filter((a): a is HerdrAgent => !!a && typeof a === "object" && typeof (a as HerdrAgent).pane_id === "string" && (a as HerdrAgent).agent === "claude");
}

/** herdr's agent status as the rest of bakr reads a session's `state`: `working` means mid-turn. */
export const stateOf = (status: string | undefined): string | undefined => status === "done" ? "idle" : status;

/** The claude process a pane runs, from `herdr pane process-info`. */
export function claudePid(result: Record<string, unknown>): number | undefined {
  const info = result["process_info"] as { foreground_processes?: { pid?: unknown; name?: unknown }[] } | undefined;
  const claude = info?.foreground_processes?.find((p) => p.name === "claude");
  return typeof claude?.pid === "number" ? claude.pid : undefined;
}

export type StartupPrompt =
  | { readonly kind: "trust"; readonly keys: readonly string[] }
  | { readonly kind: "development-channels"; readonly keys: readonly string[] }
  | { readonly kind: "unknown-blocking"; readonly excerpt: string };

/**
 * Which startup prompt a pane shows, and the keys that answer it. Only
 * prompts a bakr-launched resident must accept are answered: folder trust
 * (the directory is a claimed bakr workspace) and the development-channels
 * warning (bakr asked for those channels). Anything else is reported, never
 * guessed at — an MCP approval prompt in particular should not appear, since
 * approval travels on the launch (`--settings`).
 */
export function classifyStartupPrompt(screen: string): StartupPrompt | undefined {
  if (/Is this a project you created or one you trust/.test(screen) && /Yes, I trust this folder/.test(screen)) {
    return { kind: "trust", keys: ["down", "enter"] };
  }
  if (/WARNING: Loading development channels/.test(screen) && /I am using this for local development/.test(screen)) {
    return { kind: "development-channels", keys: ["enter"] };
  }
  if (/Enter to confirm/.test(screen)) return { kind: "unknown-blocking", excerpt: screen.trim().split("\n").slice(-14).join("\n") };
  return undefined;
}

export interface HerdrDeps {
  readonly runCommand: RunCommand;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly mintSessionId?: () => string;
}

async function herdr(deps: HerdrDeps, argv: string[], timeoutMs = HERDR_TIMEOUT_MS): Promise<HerdrReply> {
  const out = await deps.runCommand(argv, { timeoutMs });
  const reply = parseHerdrReply(out.stdout.trim() || out.stderr.trim());
  if (out.exitCode !== 0 && reply.ok) return { ok: false, code: `exit-${out.exitCode}`, message: out.stderr.trim() || "herdr exited non-zero" };
  return reply;
}

async function readScreen(deps: HerdrDeps, paneId: string): Promise<string> {
  const out = await deps.runCommand(["herdr", "agent", "read", paneId], { timeoutMs: HERDR_TIMEOUT_MS });
  return out.stdout;
}

export type HerdrLaunchResult =
  | { readonly ok: true; readonly id: string; readonly sessionId: string | undefined }
  | { readonly ok: false; readonly error: string };

/**
 * Starts claude with `claudeArgs` in a new herdr workspace rooted at `dir`,
 * answers its startup prompts, and returns the pane id once the input box is
 * idle. A launch that cannot reach idle closes its workspace — no half-started
 * pane is left holding an MCP identity — and fails with the screen excerpt.
 */
export async function herdrLaunch(dir: string, claudeArgs: readonly string[], label: string, deps: HerdrDeps): Promise<HerdrLaunchResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const created = await herdr(deps, buildWorkspaceCreateArgv(dir, label));
  if (!created.ok) return { ok: false, error: `herdr could not create a workspace: ${created.message}` };
  const root = created.result["root_pane"] as { pane_id?: unknown } | undefined;
  const workspace = created.result["workspace"] as { workspace_id?: unknown } | undefined;
  const paneId = typeof root?.pane_id === "string" ? root.pane_id : undefined;
  const workspaceId = typeof workspace?.workspace_id === "string" ? workspace.workspace_id : undefined;
  if (paneId === undefined) return { ok: false, error: "herdr created a workspace but reported no root pane" };
  const abandon = async (error: string): Promise<HerdrLaunchResult> => {
    if (workspaceId !== undefined) await herdr(deps, ["herdr", "workspace", "close", workspaceId]).catch(() => undefined);
    return { ok: false, error };
  };

  const { args, sessionId } = withSessionId(claudeArgs, deps.mintSessionId);
  const started = await herdr(deps, buildAgentStartArgv(paneId, args), AGENT_START_TIMEOUT_MS + HERDR_TIMEOUT_MS);
  if (!started.ok && started.code !== "agent_not_ready") return abandon(`claude did not start in pane ${paneId}: ${started.message}`);

  const readyBy = now() + READY_TIMEOUT_MS;
  for (;;) {
    const got = await herdr(deps, ["herdr", "agent", "get", paneId]);
    const agent = got.ok ? got.result["agent"] as HerdrAgent | undefined : undefined;
    if (agent?.interactive_ready && (agent.agent_status === "idle" || agent.agent_status === "done")) {
      const listed = agent.agent_session?.value;
      return { ok: true, id: paneId, sessionId: typeof listed === "string" ? listed : sessionId };
    }
    const prompt = classifyStartupPrompt(await readScreen(deps, paneId));
    if (prompt?.kind === "unknown-blocking") return abandon(`claude in pane ${paneId} is blocked on a prompt bakr does not answer:\n${prompt.excerpt}`);
    if (prompt !== undefined) await herdr(deps, ["herdr", "agent", "send-keys", paneId, ...prompt.keys]);
    if (now() >= readyBy) return abandon(`claude in pane ${paneId} never reached its idle input box`);
    await sleep(READY_POLL_MS);
  }
}

/** Every Claude pane herdr runs, as the rest of bakr reads a session listing: `id` is the pane id. */
export async function herdrList(deps: HerdrDeps): Promise<BackgroundSessionInfo[]> {
  const listed = await herdr(deps, ["herdr", "agent", "list"]);
  if (!listed.ok) throw new Error(`\`herdr agent list\` failed: ${listed.message}`);
  const sessions: BackgroundSessionInfo[] = [];
  for (const agent of parseAgentList(listed.result)) {
    const session = agent.agent_session?.value;
    if (typeof session !== "string") continue;
    const info = await herdr(deps, ["herdr", "pane", "process-info", "--pane", agent.pane_id]);
    sessions.push({
      id: agent.pane_id,
      sessionId: session,
      cwd: agent.cwd ?? "",
      startedAt: 0,
      pid: info.ok ? claudePid(info.result) : undefined,
      state: stateOf(agent.agent_status),
    });
  }
  return sessions;
}

/** Closes the pane's whole workspace: the claude process ends, its transcript stays for a later `--resume`. */
export async function herdrStop(paneId: string, deps: HerdrDeps): Promise<{ ok: true } | { ok: false; error: string }> {
  const workspaceId = paneId.includes(":") ? paneId.slice(0, paneId.indexOf(":")) : undefined;
  const closed = workspaceId === undefined
    ? await herdr(deps, ["herdr", "pane", "close", paneId])
    : await herdr(deps, ["herdr", "workspace", "close", workspaceId]);
  return closed.ok ? { ok: true } : { ok: false, error: closed.message };
}
