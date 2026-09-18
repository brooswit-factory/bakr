// `bakr send` over herdr. drovr's resident messenger proves delivery by the
// session's own transcript and reads the reply there; only the way it reaches
// the running process differs by host. A session in a herdr pane is typed to
// with `herdr pane send-text` / `send-keys`; a legacy `claude --bg` session
// keeps drovr's own `claude attach` transport until it is relaunched into
// herdr. The same injected RunCommand as everywhere else runs every command.

import { approvePermission, listClaudeBackgroundSessions, listPendingPermissions, openClaudeAttach, type ClaudeBackgroundListing, type ClaudeResidentDeps, type PermissionApprovalDeps, type ResidentTerminal } from "@brooswit/drovr";
import { isHerdrPaneId, listBackgroundSessions, type RunCommand } from "../spawn";
import { parseHerdrReply } from "../spawn/herdr";
import type { PermissionHost } from "./permissions";

const HERDR_TIMEOUT_MS = 15_000;

/** herdr's agent status as drovr's messenger reads a listing's `status`: only `idle` is sendable. */
const statusOf = (state: string | undefined): string | undefined => state === "working" ? "working" : state === "blocked" ? "blocked" : state === undefined ? undefined : "idle";

/**
 * A terminal onto a herdr pane shaped like drovr's attach client. Writes go
 * out in order; the pane is always "settled" because there is no attach
 * client whose startup output must be waited out. `close` only waits for the
 * writes — it never touches the pane or the session.
 */
export function openHerdrPane(paneId: string, runCommand: RunCommand): ResidentTerminal {
  let queue: Promise<unknown> = Promise.resolve();
  const send = (argv: string[]) => { queue = queue.then(() => runCommand(argv, { timeoutMs: HERDR_TIMEOUT_MS })).catch(() => undefined); };
  return {
    write: (data: string) => send(data === "\r" ? ["herdr", "pane", "send-keys", paneId, "enter"] : ["herdr", "pane", "send-text", paneId, data]),
    lastOutputAt: () => Date.now() - 60_000,
    exited: new Promise<number>(() => {}),
    close: async () => { await queue; },
  };
}

/** The messenger's transport for this host: herdr panes, plus legacy background sessions until they are relaunched. */
export function residentTransport(runCommand: RunCommand): Partial<ClaudeResidentDeps> {
  return {
    listBackground: async (): Promise<ClaudeBackgroundListing[]> =>
      (await listBackgroundSessions({ runCommand })).map((s) => {
        const status = statusOf(s.state);
        return { id: s.id, sessionId: s.sessionId, cwd: s.cwd, ...(status === undefined ? {} : { status }) };
      }),
    openAttach: (id: string, cwd: string) => isHerdrPaneId(id) ? openHerdrPane(id, runCommand) : openClaudeAttach(id, cwd),
    readScreen: async (id: string) => {
      const argv = isHerdrPaneId(id) ? ["herdr", "agent", "read", id] : ["claude", "logs", id];
      return (await runCommand(argv, { timeoutMs: HERDR_TIMEOUT_MS })).stdout;
    },
  };
}

/** drovr's permission functions take this slice of its client. */
export type ApprovalClient = Parameters<typeof listPendingPermissions>[0];
type AgentApi = ApprovalClient["agent"];

async function herdrResult(runCommand: RunCommand, argv: string[]): Promise<Record<string, unknown>> {
  const out = await runCommand(argv, { timeoutMs: HERDR_TIMEOUT_MS });
  const reply = parseHerdrReply(out.stdout);
  if (!reply.ok) throw new Error(`${argv.slice(0, 3).join(" ")}: ${reply.code}: ${reply.message}`);
  if (out.exitCode !== 0) throw new Error(`${argv.slice(0, 3).join(" ")} exited ${out.exitCode}: ${out.stderr.trim()}`);
  return reply.result;
}

/**
 * drovr's approval client over the herdr CLI, run by the same injected
 * RunCommand as every other herdr call bakr makes. The CLI prints the RPC's
 * own result for list, get and send-keys; `agent read` prints only the screen
 * text, which is the one field of a read drovr's permission functions use.
 */
export function herdrApprovalClient(runCommand: RunCommand): ApprovalClient {
  const agent: AgentApi = {
    list: async () => (await herdrResult(runCommand, ["herdr", "agent", "list"])) as unknown as Awaited<ReturnType<AgentApi["list"]>>,
    get: async (target) => (await herdrResult(runCommand, ["herdr", "agent", "get", target])) as unknown as Awaited<ReturnType<AgentApi["get"]>>,
    read: async (p) => {
      // strip_ansi is mapped, never left to herdr's default output: drovr
      // classifies the prompt from plain text, and a default that changed to
      // ansi would make every blocked pane read as "no pending prompts".
      const format = p.strip_ansi === undefined ? [] : ["--format", p.strip_ansi ? "text" : "ansi"];
      const argv = ["herdr", "agent", "read", p.target, "--source", p.source, ...(p.lines == null ? [] : ["--lines", String(p.lines)]), ...format];
      const out = await runCommand(argv, { timeoutMs: HERDR_TIMEOUT_MS });
      if (out.exitCode !== 0) throw new Error(`herdr agent read ${p.target} exited ${out.exitCode}: ${out.stderr.trim()}`);
      return { type: "pane_read", read: { text: out.stdout, pane_id: p.target, source: p.source } } as unknown as Awaited<ReturnType<AgentApi["read"]>>;
    },
    sendKeys: async (p) => (await herdrResult(runCommand, ["herdr", "agent", "send-keys", p.target, ...p.keys])) as unknown as Awaited<ReturnType<AgentApi["sendKeys"]>>,
  };
  return { agent };
}

/**
 * This host's permission prompts: every herdr pane running claude. Legacy
 * `claude --bg` sessions have no pane to read. `approve` is drovr's
 * approvePermission over the same client; `overrides` is its deps seam
 * (bakr's 0600 audit writer in bin.ts, a fake clock in tests).
 */
export function herdrPermissions(runCommand: RunCommand, overrides: Partial<PermissionApprovalDeps> = {}): PermissionHost {
  const client = herdrApprovalClient(runCommand);
  return {
    list: () => listPendingPermissions(client),
    approve: (request) => approvePermission(client, request, overrides),
  };
}

// Re-exported so bin.ts wires one module; the legacy lister stays reachable for diagnostics.
export { listClaudeBackgroundSessions };
