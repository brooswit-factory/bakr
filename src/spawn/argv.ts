// Pure argv construction for every claude / systemd-run invocation this
// substrate makes. No I/O anywhere in this file — every function here is
// exhaustively unit-testable without shelling out (see test/spawn/argv.test.ts),
// which is BAKR-11's own definition-of-done item 6.
//
// Argv arrays, never shell strings, end to end — taken from
// brooswit-factory/candlestix's src/spawn.ts and src/exec.ts: a
// caller-supplied directory or any other value reaches execve as one argv
// element and is never interpreted by a shell, so it needs no escaping even
// if it contains quotes, `$`, backticks, or newlines.

const LAUNCH_TIMEOUT_MS = 20_000;
const LIST_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 15_000;

export interface LaunchInvocation {
  argv: string[];
  cwd: string;
  timeoutMs: number;
}

/**
 * Builds the argv for one scope-wrapped launch: `systemd-run --user
 * --scope ... -- claude --bg ...`. Called only from launch.ts — see that
 * file's banner comment for why it is the sole site allowed to do so
 * (BAKR-11 §0/§9 rule 1: every launch goes through its own scope, no bare
 * `claude --bg` anywhere).
 *
 * `--expand-environment=no` is explicit rather than left to the systemd
 * default, taken from candlestix's own spawn.ts: systemd-run currently
 * warns that a command line containing `$something` is "not expanded by
 * default for now, but will be expanded by default in the future" —
 * pinning the flag makes today's behaviour permanent regardless of that
 * future default change.
 *
 * systemd-run added that option in systemd 254. Older builds reject it as an
 * unrecognized option before creating a scope, and they never expand
 * `$something` at all, so launch.ts retries once with
 * `pinExpandEnvironment: false` when that exact refusal comes back.
 *
 * The target directory travels as the child process's `cwd` (see
 * `LaunchInvocation.cwd`, consumed by the injected RunCommand), never as an
 * argv element — `claude --bg` takes no directory flag of its own.
 */
export function buildLaunchInvocation(
  dir: string,
  unitName: string,
  claudeArgs: string[] = [],
  opts: { pinExpandEnvironment?: boolean } = {},
): LaunchInvocation {
  return {
    argv: [
      "systemd-run",
      "--user",
      "--scope",
      `--unit=${unitName}`,
      "--collect",
      ...(opts.pinExpandEnvironment === false ? [] : ["--expand-environment=no"]),
      "--",
      "claude",
      "--bg",
      ...claudeArgs,
    ],
    cwd: dir,
    timeoutMs: LAUNCH_TIMEOUT_MS,
  };
}

export interface ListInvocation {
  argv: string[];
  timeoutMs: number;
}

/**
 * Builds the argv for `claude agents --json`. `underCwd`, when given, adds
 * `--cwd <path>` — measured (BAKR-11 §5b, re-verified on this substrate's
 * own test host on 2026-09-10 against claude 2.1.267) to be a SUBTREE
 * pre-filter, not an exact-directory predicate: `--cwd /a` also matches
 * sessions living in `/a/subproject`, and a nonexistent path returns `[]`
 * with exit code 0 rather than an error. Treat the result as narrowed,
 * never decided — a caller that needs an exact directory match must
 * additionally compare each result's own `cwd` field for equality (see
 * `filterExactCwd` in parse.ts) rather than trusting this flag alone.
 * Nothing in this module performs that resolution itself: no function here
 * decides "this is my session" from a directory (BAKR-11 §1 — the
 * directory scopes the question, it never answers it).
 */
export function buildListInvocation(opts?: { underCwd?: string; includeAll?: boolean }): ListInvocation {
  const argv = ["claude", "agents", "--json"];
  if (opts?.underCwd !== undefined) argv.push("--cwd", opts.underCwd);
  if (opts?.includeAll) argv.push("--all");
  return { argv, timeoutMs: LIST_TIMEOUT_MS };
}

export interface StopInvocation {
  argv: string[];
  timeoutMs: number;
}

/**
 * Builds the argv for `claude stop <id>` — the only stop mechanism this
 * substrate uses (BAKR-11 §0/§9 rules 2-4: stop takes a recorded session
 * identity; no code path kills a scope, a cgroup, or calls `systemctl
 * --user stop`). Called only from stop.ts — see that file's banner comment
 * for why it is the sole call site.
 */
export function buildStopInvocation(id: string): StopInvocation {
  return { argv: ["claude", "stop", id], timeoutMs: STOP_TIMEOUT_MS };
}

export interface RespawnInvocation {
  readonly argv: string[];
  readonly timeoutMs: number;
}

const RESPAWN_TIMEOUT_MS = 20_000;

/**
 * BAKR-22: `claude respawn <shortId>` — the argv-exactness this ticket's
 * own regression test pins. Takes the SHORT id only (`respawn` measured to
 * REJECT a full session uuid outright: `"No job matching '<uuid>'"`, rc=1
 * — this is not a stylistic choice, it is the only shape that works).
 * Never carries a permissions or model flag, and never will: BAKR-22
 * measured that `--dangerously-skip-permissions` on a restore invocation
 * is what causes `claude --bg --resume` to fork even on builds where an
 * unflagged restore correctly reattaches — the whole point of switching to
 * `respawn` collapses if a future edit ever adds a flag here.
 */
export function buildRespawnInvocation(shortId: string): RespawnInvocation {
  return { argv: ["claude", "respawn", shortId], timeoutMs: RESPAWN_TIMEOUT_MS };
}
