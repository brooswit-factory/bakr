// THE SOLE SITE IN THIS SUBSTRATE THAT STARTS A CLAUDE SESSION. Every session
// runs interactively in its own herdr workspace pane (see herdr.ts for why:
// `claude --bg` never delivers a channel frame as a turn). The pane runs under
// the herdr server, not under bakr.service, so restarting bakr never takes a
// session down — the property the per-launch systemd scope used to provide.

import type { RunCommand } from "./exec";
import { herdrLaunch } from "./herdr";

export interface LaunchDeps {
  runCommand: RunCommand;
  /** Names the herdr workspace (`bakr <label>`), normally the agent's id and name. */
  label?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Mints the session id a fresh launch names for itself. Injectable for deterministic tests. */
  mintSessionId?: () => string;
}

/** `id` is the herdr pane id — what `stopSession` and a listing's `id` key on. `sessionId` is claude's own, when the launch named or resumed one. */
export type LaunchResult = { ok: true; id: string; sessionId?: string } | { ok: false; error: string };

/**
 * Starts claude with `claudeArgs` in `dir` (which must already exist) in a
 * new herdr pane, and returns once its input box is idle — never a
 * directory-derived guess (BAKR-11 §1). `claudeArgs` is passed through
 * verbatim; what belongs there (MCP access, `--resume`) is the caller's
 * decision (launch-config.ts, agent-actions.ts, daemon.ts).
 */
export async function launch(dir: string, claudeArgs: string[], deps: LaunchDeps): Promise<LaunchResult> {
  try {
    const result = await herdrLaunch(dir, claudeArgs, deps.label ?? "agent", {
      runCommand: deps.runCommand,
      ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
      ...(deps.now === undefined ? {} : { now: deps.now }),
      ...(deps.mintSessionId === undefined ? {} : { mintSessionId: deps.mintSessionId }),
    });
    if (!result.ok) return result;
    return result.sessionId === undefined ? { ok: true, id: result.id } : { ok: true, id: result.id, sessionId: result.sessionId };
  } catch (err) {
    return { ok: false, error: `launch failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
