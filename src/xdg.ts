// Pure XDG Base Directory resolution for the claim store's persistence
// location (BAKR-10). No env read, no filesystem, no process access —
// `home` and `stateHome` are always parameters. The one impure caller
// (paths.ts) reads `process.env` / `os.homedir` once and passes them in
// here — the same pure/impure split `brooswit-factory/candlestix` draws
// between its own src/xdg.ts (pure) and src/paths.ts (impure caller),
// verified at candlestix's own commit; ported as a *pattern*.
//
// Empty-string handling: an XDG var set to "" is treated exactly like it
// being unset, per the XDG Base Directory spec and this ticket's explicit
// callout that an empty `XDG_STATE_HOME` is a real case, not hypothetical.
//
// Why state-home, not runtime-dir, for durability:
// - `XDG_RUNTIME_DIR` is documented to be removed on logout and is
//   commonly a tmpfs mount on systemd systems — gone across a reboot.
//   `brooswit-factory/candlestix`'s registry lives there deliberately,
//   because its own ticket only asked it to survive a daemon restart
//   within the same login session, not a reboot (see its src/registry.ts
//   module comment, verified at candlestix's own commit). bakr's ticket
//   asks for the opposite: reboot durability. Reusing candlestix's
//   runtime-dir choice here would silently fail bakr's own requirement,
//   so this is a deliberate divergence, not an oversight — see the
//   shipped doc for the mount-type evidence.
// - `XDG_STATE_HOME` is specified as state that should persist between
//   application restarts (and, per the spec's own wording, is meant for
//   things like logs and history that a user would not want to lose) —
//   `~/.local/state` is an ordinary directory on the real filesystem, not
//   a tmpfs.

export interface XdgInputs {
  readonly home: string;
  readonly stateHome: string | undefined;
}

function orFallback(value: string | undefined, fallback: string): string {
  return value !== undefined && value.length > 0 ? value : fallback;
}

function join(...parts: string[]): string {
  return parts
    .map((p, i) => (i === 0 ? p.replace(/\/+$/, "") : p.replace(/^\/+|\/+$/g, "")))
    .filter((p) => p.length > 0)
    .join("/");
}

export function resolveStateHome(inputs: XdgInputs): string {
  return orFallback(inputs.stateHome, join(inputs.home, ".local", "state"));
}

/** `$XDG_STATE_HOME/bakr/claims.json`, falling back per `resolveStateHome` above. */
export function claimsPath(inputs: XdgInputs): string {
  return join(resolveStateHome(inputs), "bakr", "claims.json");
}
