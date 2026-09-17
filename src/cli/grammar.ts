// Grammar scan ported from brooswit-factory/candlestix src/cli/grammar.ts
// at 13a520aa90464ec1b79ba2324864c074b0f51a3c. Bakr deliberately diverges:
// bare invocation discovers instead of creating, verbs come second, adopt
// is top-level, and agents have no --job option.
export const TOP_LEVEL_WORDS = ["list", "create", "adopt"] as const;

export type ParsedCommand =
  | { kind: "discover" }
  | { kind: "list"; showArchived: boolean }
  | { kind: "create"; name?: string }
  | { kind: "adopt"; ids: string[] }
  | { kind: "attach"; ref: string }
  | { kind: "on" | "off" | "archive" | "unarchive"; ref: string }
  | { kind: "delete"; ref: string; yes: boolean }
  | { kind: "rename"; ref: string; newName: string }
  | { kind: "send"; ref: string; message: string }
  | { kind: "help" };

export type ParseResult = { ok: true; command: ParsedCommand } | { ok: false; message: string };

type Flags = { name?: string; yes: boolean; archived: boolean; help: boolean };

function scan(argv: string[]): { ok: true; words: string[]; flags: Flags } | { ok: false; message: string } {
  const words: string[] = [];
  const flags: Flags = { yes: false, archived: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--name") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("-")) return { ok: false, message: "--name requires a value" };
      flags.name = value;
    } else if (token === "--yes" || token === "-y") flags.yes = true;
    else if (token === "--archived") flags.archived = true;
    else if (token === "--help" || token === "-h") flags.help = true;
    else if (token.startsWith("-")) return { ok: false, message: `unrecognized flag "${token}"` };
    else words.push(token);
  }
  return { ok: true, words, flags };
}

function error(message: string): ParseResult { return { ok: false, message }; }
function disallowed(f: Flags, allowed: Partial<Record<keyof Flags, boolean>>, label: string): string | undefined {
  if (f.name !== undefined && !allowed.name) return `--name is not valid with "${label}"`;
  if (f.yes && !allowed.yes) return `--yes/-y is not valid with "${label}"`;
  if (f.archived && !allowed.archived) return `--archived is not valid with "${label}"`;
  return undefined;
}

export function parseArgv(argv: string[]): ParseResult {
  const s = scan(argv); if (!s.ok) return s;
  const { words, flags } = s;
  if (flags.help) {
    if (words.length || flags.name !== undefined || flags.yes || flags.archived) return error("--help/-h must be used alone");
    return { ok: true, command: { kind: "help" } };
  }
  if (!words.length) {
    const bad = disallowed(flags, {}, "bakr");
    return bad ? error(bad) : { ok: true, command: { kind: "discover" } };
  }
  const first = words[0]!;
  if (first === "list") {
    if (words.length !== 1) return error('"list" takes no arguments');
    const bad = disallowed(flags, { archived: true }, "list");
    return bad ? error(bad) : { ok: true, command: { kind: "list", showArchived: flags.archived } };
  }
  if (first === "create") {
    if (words.length !== 1) return error('"create" takes no positional arguments');
    const bad = disallowed(flags, { name: true }, "create");
    return bad ? error(bad) : { ok: true, command: { kind: "create", ...(flags.name === undefined ? {} : { name: flags.name }) } };
  }
  if (first === "adopt") {
    const bad = disallowed(flags, {}, "adopt");
    if (bad) return error(bad);
    if (words.length < 2) return error('"adopt" requires at least one @id');
    return { ok: true, command: { kind: "adopt", ids: words.slice(1) } };
  }
  const bad = disallowed(flags, { yes: words[1] === "delete" }, words[1] ?? "attach");
  if (bad) return error(bad);
  if (words.length === 1) return { ok: true, command: { kind: "attach", ref: first } };
  const verb = words[1]!;
  if (["on", "off", "archive", "unarchive"].includes(verb)) {
    if (words.length !== 2) return error(`"${verb}" takes no further arguments`);
    return { ok: true, command: { kind: verb as "on" | "off" | "archive" | "unarchive", ref: first } };
  }
  if (verb === "delete") {
    if (words.length !== 2) return error('"delete" takes no further positional arguments');
    return { ok: true, command: { kind: "delete", ref: first, yes: flags.yes } };
  }
  if (verb === "name" || verb === "rename") {
    if (words.length !== 3) return error(`"${verb}" requires exactly one new name`);
    return { ok: true, command: { kind: "rename", ref: first, newName: words[2]! } };
  }
  if (verb === "send") {
    if (words.length !== 3) return error('"send" requires exactly one message argument; quote it');
    return { ok: true, command: { kind: "send", ref: first, message: words[2]! } };
  }
  return error(`unknown verb "${verb}"`);
}
