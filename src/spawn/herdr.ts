// The herdr substrate: every session bakr keeps alive runs as an interactive
// Claude Code process in its own herdr workspace pane, never `claude --bg`.
//
// Why: measured on claude 2.1.276, a background session never shows the
// "Loading development channels" confirmation and never delivers a channel
// frame as a turn, while the same session resumed in a terminal pane — the
// confirmation answered — receives yappr and rocketr frames as live turns
// (rocketr agent, session 517fd13a, 2026-09-18). The user's decision: agents
// live in herdr panes, like butchr's.
//
// Hosting is drovr's (BAKR-37): `herdrLaunch` is drovr's `hostResident`,
// `herdrList` reads drovr's `listResidents` (with the provider pid it
// reports), `herdrStop` is drovr's `stopResident` — all through a
// DrovrClient over the herdr CLI (herdr-cli-client.ts), so every command
// still goes through the injected RunCommand, as in the rest of spawn/.
// launch.ts, list.ts and stop.ts keep their shapes, so daemon.ts and
// agent-actions.ts do not change.
//
// What stays bakr's own, and why:
//   - Panes bakr started before drovr hosted them (workspace `bakr <id>`,
//     agent name `bakr-<id>-<ws>`) are adopted, never restarted: the listing
//     still finds every Claude pane herdr runs by its session id, and a stop
//     of one drovr does not host closes its workspace as before. A relaunch
//     moves an agent onto drovr's host.
//   - Every Claude pane herdr runs is listed, not only drovr's: a session
//     running in a pane bakr did not start is still alive, and the daemon
//     must not restore it a second time (the double-restore guard, kept
//     until DROVR-13 lands).
//   - A fork (`--resume <s> --fork-session`) is started by bakr's own loop
//     below: drovr's HostResidentRequest can resume a session or name a
//     fresh one, not fork one.
//   - drovr always adds `--permission-mode bypassPermissions`; bakr has never
//     launched with a permission mode, and whether its agents should is an
//     open decision on BAKR-37, not this change's to make. Until drovr takes a
//     permission mode on the request, that flag is removed from the start.

import { randomUUID } from "node:crypto";
import { buildProviderLaunchArgs, hostResident, listResidents, RESIDENT_WORKSPACE_PREFIX, stopResident, type ProviderLaunchInputs } from "@brooswit/drovr";
import type { RunCommand } from "./exec";
import { drovrClientOverCli } from "./herdr-cli-client";
import type { BackgroundSessionInfo } from "./parse";

const HERDR_TIMEOUT_MS = 15_000;
const AGENT_START_TIMEOUT_MS = 60_000;
const READY_TIMEOUT_MS = 90_000;
const READY_POLL_MS = 1_000;
const READY_CONFIRM_POLLS = 3;
const SHELL_READY_TIMEOUT_MS = 15_000;

/** The label every bakr-hosted workspace carries, so a listing can tell bakr's panes from anyone else's. */
export const workspaceLabel = (label: string): string => `bakr ${label}`;

export const buildWorkspaceCreateArgv = (cwd: string, label: string): string[] =>
  ["herdr", "workspace", "create", "--cwd", cwd, "--label", workspaceLabel(label), "--no-focus"];

/**
 * The herdr agent name for one pane. herdr requires agent names to be unique
 * across the server: a fixed name let only ONE bakr pane exist at a time, and
 * every later start was refused ("agent name claude is already used") after
 * its predecessor had already been stopped. The workspace id makes the name
 * unique even when a stale pane of the same agent is still open. herdr's own
 * rule (measured, 0.8.2): a lowercase letter first, then only lowercase
 * letters, digits, `-` or `_`, 1-32 characters — and workspace ids such as
 * `wE` are not lowercase, so both parts are folded.
 */
export const agentNameFor = (label: string, workspaceId: string): string => {
  const clean = (text: string) => text.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  const suffix = `-${clean(workspaceId) || "w"}`;
  return `bakr-${clean(label) || "agent"}`.slice(0, 32 - suffix.length) + suffix;
};

/** herdr 0.8.2's rule for an agent name. */
export const HERDR_AGENT_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

export const buildAgentStartArgv = (paneId: string, claudeArgs: readonly string[], name = "claude"): string[] =>
  ["herdr", "agent", "start", name, "--kind", "claude", "--pane", paneId, "--timeout", String(AGENT_START_TIMEOUT_MS), "--", ...claudeArgs];

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
 * bakr's own host, now only for a fork, which drovr's request cannot express:
 * starts claude with `claudeArgs` in a new herdr workspace rooted at `dir`,
 * answers its startup prompts, and returns the pane id once the input box is
 * idle. A launch that cannot reach idle closes its workspace — no half-started
 * pane is left holding an MCP identity — and fails with the screen excerpt.
 * Its prompt classifier and ready loop go with BAKR-40, once drovr can fork.
 */
export async function launchOutsideDrovr(dir: string, claudeArgs: readonly string[], label: string, deps: HerdrDeps): Promise<HerdrLaunchResult> {
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
  const name = agentNameFor(label, workspaceId ?? paneId);
  // A fresh workspace's shell may not be at its prompt yet; herdr then refuses the start with
  // "is not an available shell" (measured) and nothing has run, so the start is simply retried.
  const shellBy = now() + SHELL_READY_TIMEOUT_MS;
  let started = await herdr(deps, buildAgentStartArgv(paneId, args, name), AGENT_START_TIMEOUT_MS + HERDR_TIMEOUT_MS);
  while (!started.ok && /not an available shell/.test(started.message) && now() < shellBy) {
    await sleep(READY_POLL_MS);
    started = await herdr(deps, buildAgentStartArgv(paneId, args, name), AGENT_START_TIMEOUT_MS + HERDR_TIMEOUT_MS);
  }
  if (!started.ok && started.code !== "agent_not_ready") return abandon(`claude did not start in pane ${paneId}: ${started.message}`);

  // The screen is read before herdr's status is trusted: measured 2026-09-18 (lead-dynamic-atmosphere),
  // herdr called a resumed pane ready and idle before claude drew the development-channels warning,
  // with no session known yet, and the launch was reported up while the pane sat on the dialog.
  // Ready therefore also needs herdr to know the session, or — for a session herdr cannot name —
  // a clean screen on READY_CONFIRM_POLLS polls in a row.
  const readyBy = now() + READY_TIMEOUT_MS;
  let cleanPolls = 0;
  for (;;) {
    const prompt = classifyStartupPrompt(await readScreen(deps, paneId));
    if (prompt?.kind === "unknown-blocking") return abandon(`claude in pane ${paneId} is blocked on a prompt bakr does not answer:\n${prompt.excerpt}`);
    if (prompt !== undefined) {
      cleanPolls = 0;
      await herdr(deps, ["herdr", "agent", "send-keys", paneId, ...prompt.keys]);
    } else {
      const got = await herdr(deps, ["herdr", "agent", "get", paneId]);
      const agent = got.ok ? got.result["agent"] as HerdrAgent | undefined : undefined;
      const ready = agent?.interactive_ready === true && (agent.agent_status === "idle" || agent.agent_status === "done");
      cleanPolls = ready ? cleanPolls + 1 : 0;
      const listed = agent?.agent_session?.value;
      if (ready && (typeof listed === "string" || cleanPolls >= READY_CONFIRM_POLLS)) {
        return { ok: true, id: paneId, sessionId: typeof listed === "string" ? listed : sessionId };
      }
    }
    if (now() >= readyBy) return abandon(`claude in pane ${paneId} never reached its idle input box`);
    await sleep(READY_POLL_MS);
  }
}

/**
 * The Claude panes in one `herdr agent list` that drovr does not host, as the
 * rest of bakr reads a session listing: `id` is the pane id. A pane with no
 * session herdr can name is skipped, as it always was.
 */
async function otherClaudePanes(agentList: Record<string, unknown>, residentPanes: ReadonlySet<string>, deps: HerdrDeps): Promise<BackgroundSessionInfo[]> {
  const sessions: BackgroundSessionInfo[] = [];
  for (const agent of parseAgentList(agentList)) {
    const session = agent.agent_session?.value;
    if (typeof session !== "string" || residentPanes.has(agent.pane_id)) continue;
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
async function closePaneWorkspace(paneId: string, deps: HerdrDeps): Promise<{ ok: true } | { ok: false; error: string }> {
  const workspaceId = paneId.includes(":") ? paneId.slice(0, paneId.indexOf(":")) : undefined;
  const closed = workspaceId === undefined
    ? await herdr(deps, ["herdr", "pane", "close", paneId])
    : await herdr(deps, ["herdr", "workspace", "close", workspaceId]);
  return closed.ok ? { ok: true } : { ok: false, error: closed.message };
}

// --- Hosting through drovr ---------------------------------------------------

/**
 * The drovr label for a bakr agent: `bakr-` and its id without the `@`. drovr
 * makes the label the pane's herdr agent name and its workspace
 * `drovr <label>`, so it follows herdr's name rule (1-32 lowercase letters,
 * digits, `-`, `_`); an agent id (`@` + 18 lowercase base32) gives 23.
 * One label per agent: drovr refuses a second pane under a name a live pane
 * already holds (`label-taken`), so two panes can never run one agent.
 */
export const residentLabelFor = (label: string): string =>
  `bakr-${label.toLowerCase().replace(/[^a-z0-9_-]/g, "") || "agent"}`.slice(0, 32);

const DEVELOPMENT_CHANNELS = "--dangerously-load-development-channels=";

export type ResidentLaunch =
  | { readonly ok: true; readonly resume?: string; readonly sessionId?: string; readonly model?: string; readonly inputs: ProviderLaunchInputs }
  | { readonly ok: false; readonly error: string };

/**
 * Reads a launch's claude argv back into drovr's request. bakr's flags come
 * from drovr's own `buildProviderLaunchArgs` (launch-config.ts), so they read
 * back exactly; the check below rebuilds them and refuses any argv that would
 * not come out the same, so nothing a caller asked for is ever dropped
 * silently on the way into `hostResident`.
 */
export function residentLaunchFrom(claudeArgs: readonly string[]): ResidentLaunch {
  let resume: string | undefined;
  let sessionId: string | undefined;
  let model: string | undefined;
  let mcpConfigPath: string | undefined;
  let approved: string[] | undefined;
  const channels: string[] = [];
  const provider: string[] = [];
  for (let i = 0; i < claudeArgs.length; i++) {
    const arg = claudeArgs[i]!;
    const value = claudeArgs[i + 1];
    const takesValue = ["--resume", "--session-id", "--model", "--mcp-config", "--settings"].includes(arg);
    if (takesValue && value === undefined) return { ok: false, error: `claude argument ${arg} has no value` };
    if (arg === "--resume") resume = value;
    else if (arg === "--session-id") sessionId = value;
    else if (arg === "--model") model = value;
    else if (arg === "--mcp-config") { mcpConfigPath = value; provider.push(arg, value!); }
    else if (arg === "--settings") {
      const servers = approvedServersIn(value!);
      if (servers === undefined) return { ok: false, error: `drovr's hostResident cannot carry --settings ${value}: only an enabledMcpjsonServers approval is carried` };
      approved = servers;
      provider.push(arg, value!);
    } else if (arg.startsWith(DEVELOPMENT_CHANNELS)) { channels.push(arg.slice(DEVELOPMENT_CHANNELS.length)); provider.push(arg); }
    else return { ok: false, error: `drovr's hostResident cannot carry the claude argument ${arg}` };
    if (takesValue) i++;
  }
  if (resume !== undefined && sessionId !== undefined) return { ok: false, error: "a launch cannot both --resume a session and name a new one with --session-id" };
  const inputs: ProviderLaunchInputs = {
    ...(mcpConfigPath === undefined ? {} : { mcpConfigPath }),
    ...(approved === undefined ? {} : { mcpServersApproved: approved }),
    ...(channels.length === 0 ? {} : { developmentChannels: channels }),
  };
  const rebuilt = buildProviderLaunchArgs("claude", inputs);
  if (JSON.stringify(rebuilt) !== JSON.stringify(provider)) {
    return { ok: false, error: `drovr would start claude with ${JSON.stringify(rebuilt)} where bakr asked for ${JSON.stringify(provider)}` };
  }
  return {
    ok: true,
    inputs,
    ...(resume === undefined ? {} : { resume }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(model === undefined ? {} : { model }),
  };
}

/** The servers a `--settings` value approves, when that is all it says. */
function approvedServersIn(settings: string): string[] | undefined {
  try {
    const parsed = JSON.parse(settings) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const keys = Object.keys(parsed);
    const servers = (parsed as { enabledMcpjsonServers?: unknown }).enabledMcpjsonServers;
    if (keys.length !== 1 || !Array.isArray(servers) || !servers.every((s) => typeof s === "string")) return undefined;
    return servers as string[];
  } catch {
    return undefined;
  }
}

type HostClient = Parameters<typeof hostResident>[0];

/**
 * INTERIM, until drovr's request takes a permission mode (see the banner):
 * the client `hostResident` starts claude through, minus the
 * `--permission-mode bypassPermissions` drovr adds to every start.
 */
export function withoutForcedPermissionMode(client: HostClient): HostClient {
  return {
    ...client,
    agent: {
      list: () => client.agent.list(),
      get: (target) => client.agent.get(target),
      read: (p) => client.agent.read(p),
      sendKeys: (p) => client.agent.sendKeys(p),
      prompt: (p) => client.agent.prompt(p),
      start: (p) => client.agent.start({ ...p, args: withoutPermissionMode(p.args ?? []) }),
    },
  };
}

export function withoutPermissionMode(args: readonly string[]): string[] {
  const at = args.findIndex((arg, i) => arg === "--permission-mode" && args[i + 1] === "bypassPermissions");
  return at < 0 ? [...args] : [...args.slice(0, at), ...args.slice(at + 2)];
}

/**
 * Starts claude with `claudeArgs` in `dir` through drovr's `hostResident`,
 * under this agent's own label, and returns the pane id once drovr has
 * answered its startup prompts and seen the input box ready. A launch drovr
 * refuses fails with drovr's reason, and the screen excerpt when there is one;
 * drovr has already closed any workspace it created.
 */
export async function herdrLaunch(dir: string, claudeArgs: readonly string[], label: string, deps: HerdrDeps): Promise<HerdrLaunchResult> {
  if (claudeArgs.includes("--fork-session")) return launchOutsideDrovr(dir, claudeArgs, label, deps);
  const request = residentLaunchFrom(claudeArgs);
  if (!request.ok) return request;
  const now = deps.now ?? Date.now;
  const wait = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const mint = request.sessionId === undefined ? deps.mintSessionId ?? randomUUID : () => request.sessionId!;
  const hosted = await hostResident(withoutForcedPermissionMode(drovrClientOverCli(deps.runCommand)), {
    provider: "claude",
    cwd: dir,
    label: residentLabelFor(label),
    inputs: request.inputs,
    ...(request.resume === undefined ? {} : { resume: request.resume }),
    ...(request.model === undefined ? {} : { model: request.model }),
  }, {
    readyTimeoutMs: READY_TIMEOUT_MS,
    pollIntervalMs: READY_POLL_MS,
    cleanReadsWithoutSession: READY_CONFIRM_POLLS,
    startTimeoutMs: AGENT_START_TIMEOUT_MS,
    startOptions: { readinessTimeoutMs: SHELL_READY_TIMEOUT_MS, now, wait },
    now,
    wait,
    mintSessionId: mint,
  });
  if (hosted.ok) return { ok: true, id: hosted.paneId, sessionId: hosted.sessionId };
  return { ok: false, error: `${hosted.reason}: ${hosted.detail}${hosted.excerpt === undefined ? "" : `:\n${hosted.excerpt}`}` };
}

/**
 * Every Claude pane herdr runs, as the rest of bakr reads a session listing:
 * `id` is the pane id. drovr's residents come from `listResidents`, with the
 * provider pid it reports; every other Claude pane — one bakr started before
 * drovr hosted it, or one nobody here started — is listed as before, so a
 * session alive anywhere is never restored a second time.
 */
export async function herdrList(deps: HerdrDeps): Promise<BackgroundSessionInfo[]> {
  const client = drovrClientOverCli(deps.runCommand);
  // One `herdr agent list` per listing: drovr's residents and every other pane come from the same read.
  const agents = client.agent.list();
  const [residents, agentList] = await Promise.all([listResidents(sharingAgentList(client, agents)), agents]);
  const hosted: BackgroundSessionInfo[] = [];
  for (const resident of residents) {
    if (resident.provider !== "claude" || resident.sessionId === undefined) continue;
    hosted.push({ id: resident.paneId, sessionId: resident.sessionId, cwd: resident.cwd ?? "", startedAt: 0, pid: resident.pid, state: stateOf(resident.status) });
  }
  const residentPanes = new Set(residents.map((resident) => resident.paneId));
  return [...hosted, ...await otherClaudePanes(agentList as unknown as Record<string, unknown>, residentPanes, deps)];
}

/** `client`, with `agent.list` answered by one listing already in hand. */
function sharingAgentList(client: HostClient, agents: ReturnType<HostClient["agent"]["list"]>): HostClient {
  return {
    ...client,
    agent: {
      list: () => agents,
      get: (target) => client.agent.get(target),
      read: (p) => client.agent.read(p),
      sendKeys: (p) => client.agent.sendKeys(p),
      prompt: (p) => client.agent.prompt(p),
      start: (p) => client.agent.start(p),
    },
  };
}

/**
 * Closes the pane's whole workspace: the claude process ends, its transcript
 * stays for a later `--resume`. A pane in a workspace drovr hosts is stopped
 * by drovr's `stopResident`; any other (one bakr started before drovr hosted
 * it) has its workspace closed exactly as before, so adopting a pane never
 * changes how it is stopped.
 */
export async function herdrStop(paneId: string, deps: HerdrDeps): Promise<{ ok: true } | { ok: false; error: string }> {
  const client = drovrClientOverCli(deps.runCommand);
  const workspaceId = paneId.includes(":") ? paneId.slice(0, paneId.indexOf(":")) : undefined;
  const { workspaces } = await client.workspace.list();
  const drovrHosts = workspaces.some((workspace) => workspace.workspace_id === workspaceId && workspace.label.startsWith(RESIDENT_WORKSPACE_PREFIX));
  if (!drovrHosts) return closePaneWorkspace(paneId, deps);
  const stopped = await stopResident(client, paneId);
  return stopped.ok ? { ok: true } : { ok: false, error: `${stopped.reason}: ${stopped.detail}` };
}
