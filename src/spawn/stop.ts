// THE SOLE SITE IN THIS SUBSTRATE THAT STOPS A SESSION. BAKR-11 §0/§9
// rules 2-4: stop takes the session's own recorded identity (`claude stop
// <id>`); nothing here kills a scope or a cgroup, calls `systemctl --user
// stop`, or touches the shared `claude daemon run` process. This file, and
// argv.ts's buildStopInvocation which it calls, are the only two places in
// this substrate that construct a stop invocation. (liveness.ts's
// `process.kill(pid, 0)` is a liveness PROBE — signal 0, never delivered —
// not a stop mechanism; see that file's own comment.)

import type { RunCommand } from "./exec";
import { buildStopInvocation } from "./argv";

export interface StopDeps {
  runCommand: RunCommand;
}

export type StopResult = { ok: true } | { ok: false; error: string };

/**
 * Stops a background session by its own recorded short id — the identity
 * `launch()` returned, or one read back from `listBackgroundSessions()`.
 * There is no directory-accepting overload, and there must not be one
 * (BAKR-11 §1: the directory scopes the question, it never answers it).
 */
export async function stopSession(id: string, deps: StopDeps): Promise<StopResult> {
  const invocation = buildStopInvocation(id);
  try {
    const result = await deps.runCommand(invocation.argv, { timeoutMs: invocation.timeoutMs });
    if (result.exitCode !== 0) {
      return {
        ok: false,
        error: `stop exited ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim() || "(no output)"}`,
      };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `stop failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
