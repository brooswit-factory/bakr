// Thin child-process runner, injected everywhere this substrate shells out
// (launch.ts, list.ts, stop.ts) so none of their own logic — or their
// tests — ever calls Bun.spawn directly.
//
// Ported near-verbatim from brooswit-factory/candlestix's src/exec.ts:
// argv-array based throughout, never a shell string, so any caller-supplied
// value (a directory, a `claude --bg` argument) can contain arbitrary text
// (quotes, `$`, backticks, newlines) without any escaping concern — it
// reaches execve as one argv element, never interpreted by a shell.
export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunCommandOptions {
  cwd?: string;
  timeoutMs: number;
}

export interface RunCommand {
  (argv: string[], opts: RunCommandOptions): Promise<CommandResult>;
}

/**
 * Runs `argv[0]` with `argv.slice(1)` as arguments. On timeout, SIGKILLs
 * `proc` — the invoked process itself (e.g. the `systemd-run` wrapper, or
 * `claude agents`/`claude stop`) — and rejects. This is NOT the mechanism
 * this substrate uses to stop an agent (see stop.ts): `systemd-run --scope`
 * returns once its own immediate child exits, which for `claude --bg`
 * happens as soon as it finishes detaching, so a timeout here — however
 * unlikely once that point is reached — kills only the thin wrapper
 * process, never the scope or anything running inside it.
 */
export async function runCommand(argv: string[], options: RunCommandOptions): Promise<CommandResult> {
  const [cmd, ...args] = argv;
  if (cmd === undefined) {
    throw new Error("runCommand: argv must have at least one element");
  }

  const proc = Bun.spawn([cmd, ...args], {
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, options.timeoutMs);

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (timedOut) {
      throw new Error(`command timed out after ${options.timeoutMs}ms: ${argv.join(" ")}`);
    }

    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}
