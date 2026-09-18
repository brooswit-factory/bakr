// What configuration every `launch()` in this substrate carries, and where it
// comes from. Nothing here spells a `claude` flag: this module decides WHICH
// MCP servers a session must hear from, and drovr's `buildProviderLaunchArgs`
// turns that into the provider's own argv (BAKR-11 §3's "no product-shaped
// decision about what flags belong there" stays true of spawn/, and the flag
// names stay in one place, outside this repo, where the provider contract lives).
//
// Why this exists at all: a directory's `.mcp.json` can configure a server
// perfectly — yappr among them — and the session still never receives a single
// notification from it, because a claude session only subscribes to a server's
// notifications when it is launched with that server's development channel.
// Enabling the MCP server and subscribing to it are two separate acts; bakr was
// doing the first by virtue of the directory and neither by virtue of a launch.
//
// Deliberately NOT applied to `claude respawn` (see spawn/argv.ts's
// `buildRespawnInvocation`, which BAKR-22 pins as carrying no flags, ever): an
// already-launched session keeps whatever it was launched with, and picks up
// changed configuration only at its next `launch()` — a fresh one or a fork.
//
// Two places may ask for a server, and a launch honours the union of both:
// the host (`BAKR_MCP_NOTIFICATION_SERVERS`, once for the daemon) and the
// directory itself (the `channels` list in its own `.bakr.json`, read afresh
// at every launch, so opting a directory in needs no unit edit or restart).
// Either way the request is intersected with the directory's `.mcp.json`:
// nothing is subscribed to that the session does not itself configure.
// Deliberately NOT inferred from `.mcp.json` alone (e.g. "every server that
// exposes a channel"): a development channel lets a server push messages into
// the session, so subscribing is an explicit, bakr-specific opt-in, never a
// side effect of a server merely being configured.
//
// The pure half (everything but `readConfigFile`'s implementation) is
// exhaustively testable without touching the filesystem, the same seam
// paths.ts draws for every other real dependency in this tree.

import { buildProviderLaunchArgs, type ProviderLaunchInputs } from "@brooswit/drovr";
import { join } from "node:path";

export interface LaunchConfigDeps {
  /** Reads a directory's `.mcp.json` or `.bakr.json`, or resolves `undefined` when it is absent or unreadable — never throws. */
  readonly readConfigFile: (path: string) => Promise<string | undefined>;
  /**
   * MCP servers this host wants every session to hear from, configured once
   * for the daemon (see `notificationServersFromEnv`). A directory adds its
   * own through `.bakr.json` (see `parseDirectoryChannels`). A server named
   * either way is only ever requested for a directory whose own `.mcp.json`
   * actually configures it, so naming one has no effect on a session that
   * does not use it.
   */
  readonly notificationServers: readonly string[];
}

/** The MCP configuration a claude session launched in `directory` reads. */
export const mcpConfigPathFor = (directory: string): string => join(directory, ".mcp.json");

/** A directory's own bakr configuration, where it opts in to channels. */
export const bakrConfigPathFor = (directory: string): string => join(directory, ".bakr.json");

/**
 * The server names a `.mcp.json` configures, or `[]` for anything this cannot
 * read as one: absent, not JSON, or JSON of another shape. A launch is never
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
 * The MCP servers a directory's `.bakr.json` opts in to hearing from — its
 * `channels`, an array of server names: `{ "channels": ["rocketr"] }`.
 * `[]` for anything this cannot read as one (absent, not JSON, no `channels`,
 * `channels` not an array); entries that are not non-empty strings are
 * skipped. Like `.mcp.json`, configuration this cannot read never fails a
 * launch.
 */
export function parseDirectoryChannels(contents: string | undefined): string[] {
  if (contents === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const channels = (parsed as { channels?: unknown }).channels;
  if (!Array.isArray(channels)) return [];
  return channels
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

/**
 * Splits a configured list on commas and whitespace, dropping empties — so
 * `"yappr"`, `"yappr,other"` and `"yappr other"` all mean the same thing, and
 * an unset or blank value means "configure nothing", which is exactly the
 * behaviour this substrate had before any of this existed.
 */
export function parseNotificationServers(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw.split(/[\s,]+/).filter((value) => value.length > 0);
}

/**
 * The neutral inputs for one launch: the directory's own MCP configuration,
 * and the servers asked for — by this host, then by the directory's own
 * `.bakr.json`, de-duplicated in that order — that the directory's
 * `.mcp.json` actually configures. Empty inputs when that is none — a
 * directory that does not use a requested server launches byte-identically
 * to how it launched before.
 */
export async function resolveLaunchInputs(directory: string, deps: LaunchConfigDeps): Promise<ProviderLaunchInputs> {
  const directoryChannels = parseDirectoryChannels(await deps.readConfigFile(bakrConfigPathFor(directory)));
  const requested = [...new Set([...deps.notificationServers, ...directoryChannels])];
  if (requested.length === 0) return {};
  const mcpConfigPath = mcpConfigPathFor(directory);
  const configured = new Set(parseMcpServerNames(await deps.readConfigFile(mcpConfigPath)));
  const wanted = requested.filter((server) => configured.has(server));
  if (wanted.length === 0) return {};
  return { mcpConfigPath, mcpNotificationServers: wanted };
}

/**
 * The extra argv every `launch()` in this substrate appends after `claude
 * --bg`. `[]` whenever nothing is configured for this directory, so a caller
 * can always append it unconditionally.
 */
export async function claudeLaunchArgs(directory: string, deps: LaunchConfigDeps): Promise<string[]> {
  return buildProviderLaunchArgs("claude", await resolveLaunchInputs(directory, deps));
}
