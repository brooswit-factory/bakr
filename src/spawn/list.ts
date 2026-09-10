// The listing surface this substrate reads `claude agents --json` through.
// See argv.ts's buildListInvocation for the `--cwd` subtree-filter caveat
// (BAKR-11 §5b) and parse.ts's parseAgentsJson for the kind:"background"
// filtering (§5a) and the throw-on-failure discipline this function
// depends on.

import type { RunCommand } from "./exec";
import { buildListInvocation } from "./argv";
import { parseAgentsJson, type BackgroundSessionInfo } from "./parse";

export interface ListDeps {
  runCommand: RunCommand;
}

/**
 * Lists claude's currently-running background sessions. Throws on any
 * failure (non-zero exit, unparseable output) rather than returning `[]` —
 * ported discipline from candlestix's listBackgroundAgents (src/agents-cli.ts),
 * for the same reason its own comment gives: a caller must be able to tell
 * "the listing failed" apart from "the listing succeeded and found
 * nothing"; returning `[]` on failure would let a caller — or a future
 * daemon built on this substrate — spawn a duplicate next to a session
 * that is, in fact, alive.
 */
export async function listBackgroundSessions(
  deps: ListDeps,
  opts?: { underCwd?: string; includeAll?: boolean }
): Promise<BackgroundSessionInfo[]> {
  const invocation = buildListInvocation(opts);
  const result = await deps.runCommand(invocation.argv, { timeoutMs: invocation.timeoutMs });
  if (result.exitCode !== 0) {
    throw new Error(`\`claude agents --json\` exited ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return parseAgentsJson(result.stdout);
}
