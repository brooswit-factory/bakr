/**
 * A leading `--dir <path>` runs the whole command as if started in <path>:
 * bakr resolves an agent only from its own directory, and a caller that
 * cannot change directory first (a permission rule allows one plain command,
 * not `cd … && …`) names it instead. Only the leading position is read, so
 * no agent name or message text is ever taken for the option.
 */
export function takeDirOption(argv: readonly string[]): { dir?: string; rest: string[] } | { error: string } {
  if (argv[0] !== "--dir") return { rest: [...argv] };
  const dir = argv[1];
  if (dir === undefined || dir === "") return { error: "--dir needs a directory" };
  return { dir, rest: argv.slice(2) };
}
