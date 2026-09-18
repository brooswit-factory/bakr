import type { RunCommand } from "./exec";
import { buildStopInvocation } from "./argv";
import { herdrStop } from "./herdr";
import { isHerdrPaneId } from "./list";

export interface StopDeps {
  runCommand: RunCommand;
}

export type StopResult = { ok: true } | { ok: false; error: string };

/**
 * Stops a session by its own listing id — the id `launch()` returned, or one
 * read back from `listBackgroundSessions()` by exact session id. A herdr pane
 * (`w1:p1`) has its workspace closed (one per bakr session): claude exits and
 * its transcript stays for a later `--resume`. A legacy `claude --bg` short
 * id is stopped with `claude stop <id>`. Never a directory, a cgroup, or any
 * other session.
 */
export async function stopSession(id: string, deps: StopDeps): Promise<StopResult> {
  try {
    if (isHerdrPaneId(id)) return await herdrStop(id, { runCommand: deps.runCommand });
    const invocation = buildStopInvocation(id);
    const result = await deps.runCommand(invocation.argv, { timeoutMs: invocation.timeoutMs });
    if (result.exitCode !== 0) {
      return { ok: false, error: `stop exited ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim() || "(no output)"}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `stop failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
