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
// An agent with no declaration of its own uses this host's default:
// `BAKR_MCP_NOTIFICATION_SERVERS`, each server allowed and subscribed to.
// Either way the result is intersected with the directory's `.mcp.json`: a
// server the session does not itself configure is neither approved nor
// subscribed to, and is reported instead of failing silently.
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
import { join } from "node:path";

/** One server an agent may use, as bakr stores it. */
export interface McpServerDeclaration {
  readonly name: string;
  /** Whether the agent must be launched subscribed to this server's notifications. */
  readonly notifications: boolean;
}

export interface LaunchConfigDeps {
  /** Reads a directory's `.mcp.json`, or resolves `undefined` when it is absent or unreadable — never throws. */
  readonly readConfigFile: (path: string) => Promise<string | undefined>;
  /**
   * This host's default declaration, for an agent that has none of its own:
   * each server named here is allowed and subscribed to (see
   * `notificationServersFromEnv`).
   */
  readonly notificationServers: readonly string[];
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

/**
 * Splits a configured list on commas and whitespace, dropping empties — so
 * `"yappr"`, `"yappr,other"` and `"yappr other"` all mean the same thing, and
 * an unset or blank value means "configure nothing".
 */
export function parseNotificationServers(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw.split(/[\s,]+/).filter((value) => value.length > 0);
}

const SERVER_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * One command-line server spec: `yappr` (allowed) or `yappr+notify` (allowed
 * and subscribed to). Returns an error message for anything else, so the CLI
 * can refuse it before anything is stored.
 */
export function parseMcpSpec(spec: string): McpServerDeclaration | string {
  const notify = spec.endsWith("+notify");
  const name = notify ? spec.slice(0, -"+notify".length) : spec;
  if (!SERVER_NAME.test(name)) return `"${spec}" is not a server spec: expected <server> or <server>+notify, with a server name of letters, digits, "-" or "_"`;
  return { name, notifications: notify };
}

/** A declaration as the CLI prints it and accepts it back. */
export const formatMcpSpec = (server: McpServerDeclaration): string => server.notifications ? `${server.name}+notify` : server.name;

/** The host default, as a declaration: each server allowed and subscribed to. */
export const hostDefaultDeclaration = (deps: LaunchConfigDeps): readonly McpServerDeclaration[] =>
  deps.notificationServers.map((name) => ({ name, notifications: true }));

export interface ResolvedMcpAccess {
  /** The declared servers the directory's `.mcp.json` actually configures. */
  readonly servers: readonly McpServerDeclaration[];
  /** Declared servers the directory's `.mcp.json` does not configure — dropped, and worth reporting. */
  readonly missing: readonly string[];
  readonly mcpConfigPath: string;
}

/**
 * The access one start carries: the agent's own declaration, or this host's
 * default when it has none, kept to the servers the directory's `.mcp.json`
 * configures. Reads nothing when nothing is declared.
 */
export async function resolveMcpAccess(directory: string, deps: LaunchConfigDeps, declared?: readonly McpServerDeclaration[]): Promise<ResolvedMcpAccess> {
  const mcpConfigPath = mcpConfigPathFor(directory);
  const wanted = declared ?? hostDefaultDeclaration(deps);
  if (wanted.length === 0) return { servers: [], missing: [], mcpConfigPath };
  const configured = new Set(parseMcpServerNames(await deps.readConfigFile(mcpConfigPath)));
  return {
    servers: wanted.filter((server) => configured.has(server.name)),
    missing: wanted.filter((server) => !configured.has(server.name)).map((server) => server.name),
    mcpConfigPath,
  };
}

/** The neutral launch inputs drovr turns into flags; `{}` when nothing is subscribed to. */
export function launchInputsFor(access: ResolvedMcpAccess): ProviderLaunchInputs {
  const subscribed = access.servers.filter((server) => server.notifications).map((server) => server.name);
  if (access.servers.length === 0) return {};
  return {
    mcpConfigPath: access.mcpConfigPath,
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
  if (access.servers.length === 0) return;
  const servers: McpServerAccess[] = access.servers.map((server) => ({ name: server.name, notifications: server.notifications }));
  try {
    await applyMcpAccess("claude", { servers, cwd: directory, runtime: "interactive" }, deps.settingsIo ?? realMcpSettingsIo);
  } catch (err) {
    deps.warn?.(`${directory}: could not write MCP approval for ${servers.map((s) => s.name).join(", ")} (${err instanceof Error ? err.message : String(err)}); the session may stop at an approval prompt`);
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
