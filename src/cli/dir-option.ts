/**
 * A leading `--dir <path>` runs the whole command as if started in <path>.
 * BAKR-34/BAKR-42 R7: DEPRECATED — kept as an alias with identical behaviour
 * and exit codes (a caller that cannot change directory first, e.g. a
 * permission rule allowing one plain command, not `cd … && …`, still needs
 * it), but resolution no longer needs a caller's cwd at all (R4): an agent's
 * name is its path, and `bakr <parent>/<leaf> ...` reaches it from any
 * directory directly. The one-line stderr deprecation notice this implies is
 * printed by this option's one caller (`cli/bin.ts`) — this function stays
 * pure (no I/O) like every other parser in this tree. Only the leading
 * position is read, so no agent name or message text is ever taken for the
 * option.
 */
export function takeDirOption(argv: readonly string[]): { dir?: string; rest: string[] } | { error: string } {
  if (argv[0] !== "--dir") return { rest: [...argv] };
  const dir = argv[1];
  if (dir === undefined || dir === "") return { error: "--dir needs a directory" };
  return { dir, rest: argv.slice(2) };
}
