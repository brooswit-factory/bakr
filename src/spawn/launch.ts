// THE SOLE SITE IN THIS SUBSTRATE THAT CONSTRUCTS A `claude --bg`
// INVOCATION. BAKR-11 §0/§9 rule 1: every launch goes through its own
// `systemd-run --user --scope`; there must be no code path that launches
// `claude --bg` bare. This file, and argv.ts's buildLaunchInvocation which
// it calls, are the only two places in this substrate that reference
// `--bg`.
//
// Why systemd-run --user --scope at all: `claude --bg`'s first invocation
// for a Unix user spawns a long-lived `claude daemon run` singleton that
// every later `--bg` session on the host shares, inheriting the cgroup of
// whoever invoked it first (found by testing on candlestix, CNDLX-1; the
// singleton, its cgroup, and the sibling-cgroup property of the scope
// wrapper were all re-confirmed live on this substrate's own test host on
// 2026-09-10 — see this ticket's PR description for the before/after
// cgroup pair). Wrapping every launch in its own scope puts the invocation
// — and the singleton it may give birth to — in an independent, SIBLING
// cgroup before any long-lived service's own cgroup ever contains it, so a
// `systemctl --user restart` of that service cannot take the singleton,
// and every other background agent on the host sharing it, down as
// collateral damage.
//
// See exec.ts's own doc comment for why its timeout SIGKILLs only the
// invoking wrapper process, never the scope or anything running inside it.

import { randomUUID } from "node:crypto";
import type { RunCommand } from "./exec";
import { buildLaunchInvocation } from "./argv";
import { parseLaunchId } from "./parse";

export interface LaunchDeps {
  runCommand: RunCommand;
  /** Generates the `--unit=` suffix for each launch's systemd-run scope. Injectable for deterministic tests; defaults to a fresh random one per call. */
  generateUnitSuffix?: () => string;
}

export type LaunchResult = { ok: true; id: string } | { ok: false; error: string };

/**
 * Launches a `claude` session in `dir` (which must already exist — this
 * substrate never creates it) via a per-launch `systemd-run --user
 * --scope` wrapping `claude --bg`, and returns the launched session's own
 * short id — never a directory-derived guess (BAKR-11 §1: nothing may
 * resolve or adopt an agent by cwd alone; a `stopTheAgentIn(directory)`
 * shape is explicitly forbidden, and this function's own return type has
 * no room for one).
 *
 * `claudeArgs` is passed through verbatim, one argv element each, appended
 * after `claude --bg` — this substrate makes no product-shaped decision
 * about what flags belong there (system prompts, MCP config, etc.); that
 * is the daemon story's call (BAKR-11 §3), and this is the "clean
 * injectable seam so the daemon story can drive it" the ticket asks for.
 */
export async function launch(dir: string, claudeArgs: string[], deps: LaunchDeps): Promise<LaunchResult> {
  const generateUnitSuffix = deps.generateUnitSuffix ?? (() => randomUUID().slice(0, 8));
  const unitName = `bakr-launch-${generateUnitSuffix()}`;
  const invocation = buildLaunchInvocation(dir, unitName, claudeArgs);

  try {
    const result = await deps.runCommand(invocation.argv, { cwd: invocation.cwd, timeoutMs: invocation.timeoutMs });
    if (result.exitCode !== 0) {
      return {
        ok: false,
        error: `launch exited ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim() || "(no output)"}`,
      };
    }
    const id = parseLaunchId(result.stdout);
    return { ok: true, id };
  } catch (err) {
    return { ok: false, error: `launch failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
