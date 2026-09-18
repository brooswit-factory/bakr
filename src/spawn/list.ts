import type { RunCommand } from "./exec";
import { buildListInvocation } from "./argv";
import { herdrList } from "./herdr";
import { parseAgentsJson, type BackgroundSessionInfo } from "./parse";

export interface ListDeps {
  runCommand: RunCommand;
}

/**
 * Every running session bakr may own: the Claude panes herdr hosts (`id` is
 * the pane id, e.g. `w1:p1`) AND any legacy `claude --bg` session still
 * running from before bakr moved to herdr (`id` is its short id). Listing
 * the legacy ones keeps them alive-and-accounted-for: a daemon that saw only
 * herdr would call such an agent absent and resume its session in a pane
 * while the background process still runs — two processes on one session.
 * `relaunch` is what moves a legacy session into herdr, explicitly.
 *
 * Throws on any failure rather than returning `[]` — ported discipline from
 * candlestix's listBackgroundAgents: a caller must be able to tell "the
 * listing failed" apart from "nothing is running", or it could start a
 * duplicate next to a session that is, in fact, alive.
 *
 * `underCwd` narrows to sessions whose cwd is at or under that directory.
 * `includeAll` also lists legacy background sessions that have ended
 * (claude's `--all`); herdr lists only live panes, and a pane it no longer
 * lists has ended.
 */
export async function listBackgroundSessions(
  deps: ListDeps,
  opts?: { underCwd?: string; includeAll?: boolean }
): Promise<BackgroundSessionInfo[]> {
  const hosted = await herdrList({ runCommand: deps.runCommand });
  const invocation = buildListInvocation(opts?.includeAll ? { includeAll: true } : undefined);
  const result = await deps.runCommand(invocation.argv, { timeoutMs: invocation.timeoutMs });
  if (result.exitCode !== 0) {
    throw new Error(`\`claude agents --json\` exited ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  const legacy = parseAgentsJson(result.stdout);
  const sessions = [...hosted, ...legacy];
  const under = opts?.underCwd;
  return under === undefined ? sessions : sessions.filter((s) => s.cwd === under || s.cwd.startsWith(`${under}/`));
}

/** Whether a listing id names a herdr pane (`w1:p1`) rather than a legacy background session's short id. */
export const isHerdrPaneId = (id: string): boolean => id.includes(":");
