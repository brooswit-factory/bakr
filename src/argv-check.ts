// BAKR-61: whether a running agent was started the way bakr would start it
// now. Pure: the caller reads the live argv (herdr `pane process-info`) and the
// flags bakr would launch with (`expectedClaudeLaunchArgs`), and this decides.
//
// Why it exists (measured 2026-09-19, laptop): after a reboot herdr's own
// `resume_agents_on_restore` brought every agent back as a bare
// `claude --resume <id>` — same pane, same session id — so the liveness check,
// which keys on the session, called them healthy while none of them had its
// channel flags and every one was deaf on rocketr and yappr. herdr keeps no
// launch argv to restore (`launch_argv` is never written to its session.json),
// so a restore it does can only ever be bare, whoever first started the pane.
//
// drovr's `checkManagedAgentArgv` covers the channel flags (both spellings),
// `--mcp-config` (exact value; bakr always passes a path, never inline JSON)
// and `--permission-mode` (skipped here: bakr launches with none). What it does
// not compare, this adds: the `--settings` approval (parsed, so key order and
// whitespace never matter), the session id, and the absence of any permission
// bypass — bakr strips drovr's forced `bypassPermissions` from every start
// (spawn/herdr.ts), and one that arrived anyway would not be flagged by drovr
// because the expected argv carries no permission mode to compare against.

import { checkManagedAgentArgv } from "@brooswit/drovr";

export type ArgvVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const valueOf = (argv: readonly string[], flag: string): string | undefined => {
  const at = argv.indexOf(flag);
  return at >= 0 ? argv[at + 1] : undefined;
};

/** The servers a `--settings` value approves, sorted, or `undefined` when it names none this can read. */
function approvedServers(settings: string | undefined): string[] | undefined {
  if (settings === undefined) return undefined;
  try {
    const servers = (JSON.parse(settings) as { enabledMcpjsonServers?: unknown } | null)?.enabledMcpjsonServers;
    return Array.isArray(servers) && servers.every((s) => typeof s === "string") ? [...servers as string[]].sort() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The session a live argv names: `--resume <id>` or `--session-id <id>`.
 * `undefined` for a fork (`--resume <old> --fork-session` runs a session whose
 * id the argv never states) or an argv that names none; the session is then
 * not compared, since there is nothing in the argv to compare.
 */
function namedSession(argv: readonly string[]): string | undefined {
  if (argv.includes("--fork-session")) return undefined;
  return valueOf(argv, "--resume") ?? valueOf(argv, "--session-id");
}

const BYPASS = /^--(allow-)?dangerously-skip-permissions$|^--dangerously-bypass-approvals-and-sandbox$/;

function bypassIn(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--permission-mode" && argv[i + 1] === "bypassPermissions") return `${arg} ${argv[i + 1]}`;
    if (arg === "--permission-mode=bypassPermissions" || BYPASS.test(arg)) return arg;
  }
  return undefined;
}

/**
 * Whether `observed` (a live claude process's argv, `argv[0]` included or not)
 * carries everything `expected` (the flags bakr would launch this agent with,
 * no session flag) asks for, runs `sessionId`, and bypasses no permissions.
 * Every difference found is named in `reason`, not only the first.
 */
export function checkAgentArgv(expected: readonly string[], observed: readonly string[], sessionId: string): ArgvVerdict {
  const problems: string[] = [];
  const drovr = checkManagedAgentArgv(expected, observed);
  if (!drovr.ok) problems.push(drovr.reason);

  const wantSettings = valueOf(expected, "--settings");
  if (wantSettings !== undefined) {
    const want = approvedServers(wantSettings);
    const have = approvedServers(valueOf(observed, "--settings"));
    if (have === undefined) problems.push(`argv lacks --settings ${wantSettings}`);
    else if (want === undefined || want.join("\n") !== have.join("\n")) problems.push(`--settings approves ${JSON.stringify(have)}, not ${JSON.stringify(want ?? wantSettings)}`);
  }

  const session = namedSession(observed);
  if (session !== undefined && session !== sessionId) problems.push(`runs session ${session}, not ${sessionId}`);

  const bypass = bypassIn(observed);
  if (bypass !== undefined) problems.push(`carries ${bypass}; bakr agents start with no permission bypass`);

  return problems.length === 0 ? { ok: true } : { ok: false, reason: problems.join("; ") };
}
