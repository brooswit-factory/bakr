// `bakr send` over herdr. drovr's resident messenger proves delivery by the
// session's own transcript and reads the reply there; only the way it reaches
// the running process differs by host. A session in a herdr pane is typed to
// with `herdr pane send-text` / `send-keys`; a legacy `claude --bg` session
// keeps drovr's own `claude attach` transport until it is relaunched into
// herdr. The same injected RunCommand as everywhere else runs every command.

import { listClaudeBackgroundSessions, openClaudeAttach, type ClaudeBackgroundListing, type ClaudeResidentDeps, type ResidentTerminal } from "@brooswit/drovr";
import { isHerdrPaneId, listBackgroundSessions, type RunCommand } from "../spawn";

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

// Re-exported so bin.ts wires one module; the legacy lister stays reachable for diagnostics.
export { listClaudeBackgroundSessions };
