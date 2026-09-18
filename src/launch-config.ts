// What MCP access every session this substrate starts carries, and where it
// comes from. Nothing here spells a vendor's flag or settings key: bakr owns
// the DECLARATION — which servers an agent may use, and which of them it must
// hear notifications from — and drovr renders it (`applyMcpAccess` writes the
// vendor's approval settings, `buildProviderLaunchArgs` spells the launch
// flags), so the provider contract stays in one place, outside this repo.
//
// Why bakr owns it: an agent's MCP access used to be scattered across three
// places, and each gap failed silently in its own way. `.mcp.json` defines the
// server; without Claude's `enabledMcpjsonServers` approval a fresh session
// sits `blocked` on an approval prompt nobody can answer; and without the
// server's development channel at launch it never hears a notification. Now
// one declaration per agent, in bakr's own store (`AgentRecord.mcp`), drives
// the approval and the subscription together, read by the CLI and the daemon
// alike — so it no longer matters which of them starts the session.
//
// Channels are on by default: every server an agent has is subscribed to,
// unless its declaration opts that one server out (`<server>:no-notify`). An
// agent with no declaration of its own has every server its directory's
// `.mcp.json` configures. Either way the result is intersected with that
// `.mcp.json`: a server the session does not itself configure is neither
// approved nor subscribed to, and is reported instead of failing silently.
//
// Approval is re-applied before EVERY start, respawns included, because Claude
// reads it at process start. Launch flags go only to a fresh launch or a fork:
// `claude respawn` takes none from bakr (BAKR-22), and Claude re-applies the
// flags the session was first launched with — so a changed subscription
// reaches an existing agent only through a fresh launch.

import {
  applyMcpAccess,
  buildProviderLaunchArgs,
  realMcpSettingsIo,
  type McpServerAccess,
  type McpSettingsIo,
  type ProviderLaunchInputs,
} from "@brooswit/drovr";
import { dirname, join } from "node:path";

/** One server an agent may use, as bakr stores it. */
export interface McpServerDeclaration {
  readonly name: string;
  /** Whether the agent is launched subscribed to this server's notifications — true unless opted out. */
  readonly notifications: boolean;
}

export interface LaunchConfigDeps {
  /** Reads a directory's `.mcp.json`, or resolves `undefined` when it is absent or unreadable — never throws. */
  readonly readConfigFile: (path: string) => Promise<string | undefined>;
  /** Where the vendor's approval settings are read and written. Defaults to the real filesystem. */
  readonly settingsIo?: McpSettingsIo;
  /** Where a problem that must not fail the start is reported. Defaults to nowhere. */
  readonly warn?: (message: string) => void;
}

/** The MCP configuration a claude session started in `directory` reads. */
export const mcpConfigPathFor = (directory: string): string => join(directory, ".mcp.json");

/**
 * The server names a `.mcp.json` configures, or `[]` for anything this cannot
 * read as one: absent, not JSON, or JSON of another shape. A start is never
 * blocked or failed by unreadable configuration — it simply carries none.
 */
export function parseMcpServerNames(contents: string | undefined): string[] {
  if (contents === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const servers = (parsed as { mcpServers?: unknown }).mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return [];
  return Object.keys(servers as Record<string, unknown>);
}

const SERVER_NAME = /^[A-Za-z0-9_-]+$/;

const OPT_OUT = ":no-notify";

/**
 * One command-line server spec: `yappr` (allowed and subscribed to — channels
 * are on by default) or `yappr:no-notify` (allowed, not subscribed). The
 * older `yappr+notify` still parses, as the default it now is. `:` cannot
 * occur in a server name, so no name is ever mistaken for an opt-out. Returns
 * an error message for anything else, so the CLI refuses it before anything
 * is stored.
 */
export function parseMcpSpec(spec: string): McpServerDeclaration | string {
  const quiet = spec.endsWith(OPT_OUT);
  const name = quiet ? spec.slice(0, -OPT_OUT.length) : spec.endsWith("+notify") ? spec.slice(0, -"+notify".length) : spec;
  if (!SERVER_NAME.test(name)) return `"${spec}" is not a server spec: expected <server> or <server>${OPT_OUT}, with a server name of letters, digits, "-" or "_"`;
  return { name, notifications: !quiet };
}

/** A declaration as the CLI prints it and accepts it back. */
export const formatMcpSpec = (server: McpServerDeclaration): string => server.notifications ? server.name : `${server.name}${OPT_OUT}`;

export interface ResolvedMcpAccess {
  /**
   * The declared servers the directory's `.mcp.json` actually configures, plus
   * any parent-defined server the agent's declaration names (an explicit
   * opt-in), less any the workspace explicitly disables.
   */
  readonly servers: readonly McpServerDeclaration[];
  /** Of `servers`, those opted into by name from a parent `.mcp.json` rather than the directory's own. */
  readonly fromParent: readonly string[];
  /** Declared servers no `.mcp.json` here or above configures — dropped, and worth reporting. */
  readonly missing: readonly string[];
  /**
   * Servers only a PARENT directory's `.mcp.json` defines, not yet disabled
   * here. Claude loads those too and stops at "New MCP server found in this
   * project" for them (measured: factory-dashboard, 2026-09-18). They are
   * disabled for this agent, never approved: a parent's entry is another
   * agent's (the parent directory's own), with its Rocket.Chat account and
   * yappr identity, and approving it would have this agent speak as that one
   * — unless the agent's own declaration names it (`bakr <agent> mcp <name>`).
   */
  readonly inherited: readonly string[];
  readonly mcpConfigPath: string;
}

/** Every directory above `directory`, nearest first, up to the filesystem root. */
export function parentDirsOf(directory: string): string[] {
  const parents: string[] = [];
  for (let dir = dirname(directory); ; dir = dirname(dir)) {
    parents.push(dir);
    if (dirname(dir) === dir) return parents;
  }
}

/** The workspace settings file Claude reads approvals and disables from. */
export const localSettingsPathFor = (directory: string): string => join(directory, ".claude", "settings.local.json");

/** The servers a settings file explicitly disables (`disabledMcpjsonServers`); `[]` for anything unreadable. */
export function parseDisabledServers(contents: string | undefined): string[] {
  if (contents === undefined) return [];
  try {
    const disabled = (JSON.parse(contents) as { disabledMcpjsonServers?: unknown }).disabledMcpjsonServers;
    return Array.isArray(disabled) ? disabled.filter((name): name is string => typeof name === "string") : [];
  } catch {
    return [];
  }
}

/**
 * The access one start carries: the agent's own declaration, or — when it has
 * none — every server the directory's `.mcp.json` configures, each subscribed
 * to; kept to the servers that `.mcp.json` configures, less any the
 * workspace explicitly disables. A declaration may also name a server only a
 * parent `.mcp.json` defines: that is the one way to opt in to one. An empty
 * declaration is an agent with no MCP of its own — but servers a parent
 * `.mcp.json` would still load are found either way, so they can be disabled
 * rather than prompt.
 */
export async function resolveMcpAccess(directory: string, deps: LaunchConfigDeps, declared?: readonly McpServerDeclaration[]): Promise<ResolvedMcpAccess> {
  const mcpConfigPath = mcpConfigPathFor(directory);
  const configuredNames = parseMcpServerNames(await deps.readConfigFile(mcpConfigPath));
  const configured = new Set(configuredNames);
  const disabled = new Set(parseDisabledServers(await (deps.settingsIo ?? realMcpSettingsIo).readSettings(localSettingsPathFor(directory)).catch(() => undefined)));
  const parentNames = new Set<string>();
  for (const parent of parentDirsOf(directory)) {
    for (const name of parseMcpServerNames(await deps.readConfigFile(mcpConfigPathFor(parent)))) parentNames.add(name);
  }
  const wanted = declared ?? configuredNames.map((name) => ({ name, notifications: true }));
  const optedIn = new Set(wanted.map((server) => server.name).filter((name) => !configured.has(name) && parentNames.has(name)));
  const inherited = [...parentNames].filter((name) => !configured.has(name) && !disabled.has(name) && !optedIn.has(name));
  // An explicit disable in the workspace's own settings wins: such a server is neither approved nor subscribed.
  const servers = wanted.filter((server) => (configured.has(server.name) || optedIn.has(server.name)) && !disabled.has(server.name));
  return {
    servers,
    fromParent: servers.map((server) => server.name).filter((name) => optedIn.has(name)),
    missing: wanted.filter((server) => !configured.has(server.name) && !optedIn.has(server.name)).map((server) => server.name),
    inherited,
    mcpConfigPath,
  };
}

/**
 * The neutral launch inputs drovr turns into flags; `{}` when nothing is
 * declared. Approval travels on the launch too (`mcpServersApproved`), not
 * only in the workspace's `settings.local.json`: measured, Claude ignores that
 * file in an untrusted directory, and a probe session there stopped at the
 * approval prompt despite it.
 */
export function launchInputsFor(access: ResolvedMcpAccess): ProviderLaunchInputs {
  const subscribed = access.servers.filter((server) => server.notifications).map((server) => server.name);
  if (access.servers.length === 0) return {};
  // Claude finds a parent's servers itself; `--mcp-config` names only the directory's own file, which may not exist.
  const ownConfig = access.servers.some((server) => !access.fromParent.includes(server.name));
  return {
    ...(ownConfig ? { mcpConfigPath: access.mcpConfigPath } : {}),
    mcpServersApproved: access.servers.map((server) => server.name),
    ...(subscribed.length === 0 ? {} : { mcpNotificationServers: subscribed }),
  };
}

/**
 * Writes the vendor approval this access needs before a session starts, via
 * drovr. Never throws: a settings file drovr refuses to rewrite (unparseable,
 * a symlink) is reported through `warn`, and the start goes ahead exactly as
 * it would have before bakr wrote approvals at all.
 */
export async function provisionMcpAccess(directory: string, access: ResolvedMcpAccess, deps: LaunchConfigDeps): Promise<void> {
  if (access.missing.length > 0) {
    deps.warn?.(`${directory}: MCP server(s) ${access.missing.join(", ")} are declared but not configured in ${access.mcpConfigPath}; the session starts without them`);
  }
  if (access.inherited.length > 0) await disableInherited(directory, access.inherited, deps);
  if (access.servers.length === 0) return;
  const servers: McpServerAccess[] = access.servers.map((server) => ({ name: server.name, notifications: server.notifications }));
  try {
    await applyMcpAccess("claude", { servers, cwd: directory, runtime: "interactive" }, deps.settingsIo ?? realMcpSettingsIo);
  } catch (err) {
    deps.warn?.(`${directory}: could not write MCP approval for ${servers.map((s) => s.name).join(", ")} (${err instanceof Error ? err.message : String(err)}); the session may stop at an approval prompt`);
  }
}

/**
 * Adds `names` to the workspace's `disabledMcpjsonServers`, keeping every
 * other setting. Never throws: a settings file that cannot be read as a JSON
 * object is left alone and reported, since the start then stops at Claude's
 * prompt exactly as it would have before.
 */
async function disableInherited(directory: string, names: readonly string[], deps: LaunchConfigDeps): Promise<void> {
  const io = deps.settingsIo ?? realMcpSettingsIo;
  const path = localSettingsPathFor(directory);
  try {
    const raw = await io.readSettings(path);
    const settings = raw === undefined || raw.trim() === "" ? {} : JSON.parse(raw) as unknown;
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error(`${path} is not a JSON object`);
    const current = settings as Record<string, unknown>;
    const disabled = [...new Set([...parseDisabledServers(JSON.stringify(current)), ...names])];
    await io.writeSettings(path, `${JSON.stringify({ ...current, disabledMcpjsonServers: disabled }, null, 2)}\n`);
    deps.warn?.(`${directory}: disabled ${names.join(", ")} for this agent — defined only by a parent directory's .mcp.json (another agent's config); to use one, give this agent its own entry in ${mcpConfigPathFor(directory)}, or opt in by name with \`bakr <agent> mcp <name>\``);
  } catch (err) {
    deps.warn?.(`${directory}: could not disable parent-defined MCP server(s) ${names.join(", ")} (${err instanceof Error ? err.message : String(err)}); the session may stop at an approval prompt`);
  }
}

/**
 * Everything a fresh launch or fork needs: approval written, then the extra
 * argv drovr spells for the subscription. `[]` whenever nothing applies, so a
 * caller can always pass it unconditionally.
 */
export async function claudeLaunchArgs(directory: string, deps: LaunchConfigDeps, declared?: readonly McpServerDeclaration[]): Promise<string[]> {
  const access = await resolveMcpAccess(directory, deps, declared);
  await provisionMcpAccess(directory, access, deps);
  return buildProviderLaunchArgs("claude", launchInputsFor(access));
}

/** Approval only: what a respawn needs (it takes no flags from bakr), and what a changed declaration writes at once. */
export async function provisionMcpFor(directory: string, deps: LaunchConfigDeps, declared?: readonly McpServerDeclaration[]): Promise<void> {
  await provisionMcpAccess(directory, await resolveMcpAccess(directory, deps, declared), deps);
}
