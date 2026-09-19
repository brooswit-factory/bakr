// Grammar scan ported from brooswit-factory/candlestix src/cli/grammar.ts
// at 13a520aa90464ec1b79ba2324864c074b0f51a3c. Bakr deliberately diverges:
// bare invocation discovers instead of creating, verbs come second, adopt
// is top-level, and agents have no --job option.
export const TOP_LEVEL_WORDS = ["list", "create", "adopt", "relaunch", "status"] as const;

export type ParsedCommand =
  | { kind: "discover" }
  | { kind: "list"; showArchived: boolean }
  | { kind: "create"; name?: string; mcp?: string[] }
  | { kind: "adopt"; ids: string[] }
  | { kind: "attach"; ref: string }
  | { kind: "on" | "off" | "archive" | "unarchive"; ref: string }
  | { kind: "delete"; ref: string; yes: boolean }
  | { kind: "rename"; ref: string; newName: string }
  | { kind: "send"; ref: string; message: string }
  /** Read-only: the tool-permission prompts waiting on this agent's own pane. */
  | { kind: "permissions"; ref: string }
  /**
   * Answers one prompt `permissions` listed. `always` is true only when
   * `--always` was typed; `operator` only when `--as` was (else `$USER`).
   */
  | { kind: "approve"; ref: string; promptId: string; always: boolean; operator?: string }
  /** `specs` omitted shows the declaration; `["default"]` returns it to the default (every server in its .mcp.json); otherwise it replaces it. */
  | { kind: "mcp"; ref: string; specs?: string[] }
  | { kind: "relaunch"; ref: string }
  | { kind: "relaunch-all" }
  /** BAKR-48: a read-only health report of every agent on this host. `json` prints the documented document; without it, a short human summary of the same data. */
  | { kind: "status"; json: boolean }
  | { kind: "help" };

export type ParseResult = { ok: true; command: ParsedCommand } | { ok: false; message: string };

type Flags = { name?: string; mcp: string[]; yes: boolean; archived: boolean; all: boolean; json: boolean; always: boolean; as?: string; help: boolean };

function scan(argv: string[]): { ok: true; words: string[]; flags: Flags } | { ok: false; message: string } {
  const words: string[] = [];
  const flags: Flags = { mcp: [], yes: false, archived: false, all: false, json: false, always: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--name") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("-")) return { ok: false, message: "--name requires a value" };
      flags.name = value;
    } else if (token === "--mcp") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("-")) return { ok: false, message: "--mcp requires a server spec" };
      flags.mcp.push(value);
    } else if (token === "--as") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("-")) return { ok: false, message: "--as requires an operator name" };
      if (value.trim() === "") return { ok: false, message: "--as requires a non-empty operator name" };
      flags.as = value;
    } else if (token === "--yes" || token === "-y") flags.yes = true;
    else if (token === "--archived") flags.archived = true;
    else if (token === "--all") flags.all = true;
    else if (token === "--json") flags.json = true;
    else if (token === "--always") flags.always = true;
    else if (token === "--help" || token === "-h") flags.help = true;
    else if (token.startsWith("-")) return { ok: false, message: `unrecognized flag "${token}"` };
    else words.push(token);
  }
  return { ok: true, words, flags };
}

function error(message: string): ParseResult { return { ok: false, message }; }
function disallowed(f: Flags, allowed: Partial<Record<keyof Flags, boolean>>, label: string): string | undefined {
  if (f.name !== undefined && !allowed.name) return `--name is not valid with "${label}"`;
  if (f.mcp.length > 0 && !allowed.mcp) return `--mcp is not valid with "${label}"`;
  if (f.yes && !allowed.yes) return `--yes/-y is not valid with "${label}"`;
  if (f.archived && !allowed.archived) return `--archived is not valid with "${label}"`;
  if (f.all && !allowed.all) return `--all is not valid with "${label}"`;
  if (f.json && !allowed.json) return `--json is not valid with "${label}"`;
  if (f.always && !allowed.always) return `--always is not valid with "${label}"`;
  if (f.as !== undefined && !allowed.as) return `--as is not valid with "${label}"`;
  return undefined;
}

export function parseArgv(argv: string[]): ParseResult {
  const s = scan(argv); if (!s.ok) return s;
  const { words, flags } = s;
  if (flags.help) {
    if (words.length || flags.name !== undefined || flags.mcp.length > 0 || flags.yes || flags.archived || flags.all || flags.json) return error("--help/-h must be used alone");
    if (words.length || flags.name !== undefined || flags.mcp.length > 0 || flags.yes || flags.archived || flags.all || flags.always || flags.as !== undefined) return error("--help/-h must be used alone");
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
    const bad = disallowed(flags, { name: true, mcp: true }, "create");
    return bad ? error(bad) : { ok: true, command: { kind: "create", ...(flags.name === undefined ? {} : { name: flags.name }), ...(flags.mcp.length === 0 ? {} : { mcp: flags.mcp }) } };
  }
  if (first === "status") {
    if (words.length !== 1) return error('"status" takes no arguments');
    const bad = disallowed(flags, { json: true }, "status");
    return bad ? error(bad) : { ok: true, command: { kind: "status", json: flags.json } };
  }
  if (first === "relaunch") {
    const bad = disallowed(flags, { all: true }, "relaunch");
    if (bad) return error(bad);
    if (words.length !== 1 || !flags.all) return error('"relaunch" at the top level takes only --all; relaunch one agent with "bakr <id|name> relaunch"');
    return { ok: true, command: { kind: "relaunch-all" } };
  }
  if (first === "adopt") {
    const bad = disallowed(flags, {}, "adopt");
    if (bad) return error(bad);
    if (words.length < 2) return error('"adopt" requires at least one @id');
    return { ok: true, command: { kind: "adopt", ids: words.slice(1) } };
  }
  const bad = disallowed(flags, { yes: words[1] === "delete", always: words[1] === "approve", as: words[1] === "approve" }, words[1] ?? "attach");
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
  if (verb === "relaunch") {
    if (words.length !== 2) return error('"relaunch" takes no further arguments');
    return { ok: true, command: { kind: "relaunch", ref: first } };
  }
  if (verb === "permissions") {
    if (words.length !== 2) return error('"permissions" takes no further arguments');
    return { ok: true, command: { kind: "permissions", ref: first } };
  }
  if (verb === "approve") {
    if (words.length !== 3) return error('"approve" requires exactly one promptId; `bakr <id|name> permissions` lists them');
    return { ok: true, command: { kind: "approve", ref: first, promptId: words[2]!, always: flags.always, ...(flags.as === undefined ? {} : { operator: flags.as }) } };
  }
  if (verb === "mcp") {
    const specs = words.slice(2);
    if (specs.includes("default") && specs.length !== 1) return error('"mcp default" takes no server specs');
    return { ok: true, command: { kind: "mcp", ref: first, ...(specs.length === 0 ? {} : { specs }) } };
  }
  if (verb === "send") {
    if (words.length !== 3) return error('"send" requires exactly one message argument; quote it');
    return { ok: true, command: { kind: "send", ref: first, message: words[2]! } };
  }
  return error(`unknown verb "${verb}"`);
}
