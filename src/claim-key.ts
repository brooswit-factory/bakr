// The pure, lexical half of claim-path normalization (BAKR-10). No
// filesystem, no clock, no ambient env read: `cwd` and `home` are always
// parameters, the same pure/impure split brooswit-factory/candlestix uses
// between src/xdg.ts (pure) and src/paths.ts (the one impure caller) —
// verified at candlestix's own commit before this was written; ported as
// a *pattern*, not literal code, since the inputs differ.
//
// This step handles: `~` expansion, relative-to-`cwd` resolution,
// trailing-slash stripping, and bare `.` segment removal.
//
// It deliberately does NOT collapse `..` segments, even though an earlier
// draft of this module did (via `node:path`'s `resolve`, which collapses
// both `.` and `..` together) — that was a real bug, caught by a failing
// integration test, not a style choice reversed for its own sake. Collapsing
// `/a/link/..` to `/a` lexically is only correct when `link` is not a
// symlink; when it is, the real parent is the parent of `link`'s target,
// and by the time a lexically-collapsed string reaches the impure resolver
// in claim-key-resolve.ts, that information is already gone — no resolver,
// however careful, can recover it from a string that no longer has the
// `..` in it. So `..` handling is left entirely to claim-key-resolve.ts's
// symlink-aware walk, which has the filesystem access this module
// deliberately does not.
//
// `.` segments are safe to drop here regardless of symlinks — a bare `.`
// never changes location — so this module still removes them, the one
// piece of "collapsing" that was never the problem.

export interface LexicalInputs {
  /** Must be absolute. The caller's job (see paths.ts) — this module does not verify it. */
  readonly cwd: string;
  /** Must be absolute. The caller's job (see paths.ts) — this module does not verify it. */
  readonly home: string;
}

/** `~` and `~/rest` only — bare `~user` (another user's home) is not handled and passes through unchanged. */
export function expandHome(input: string, home: string): string {
  if (input === "~") {
    return home;
  }
  if (input.startsWith("~/")) {
    return `${home.replace(/\/+$/, "")}/${input.slice(2)}`;
  }
  return input;
}

/** `resolve`'s absoluteness check only — never used for its `.`/`..` collapsing, which this module deliberately avoids (see module comment). */
function toAbsolute(path: string, cwd: string): string {
  if (path.startsWith("/")) {
    return path;
  }
  return `${cwd.replace(/\/+$/, "")}/${path}`;
}

/**
 * `~` expansion, then relative-to-`cwd` resolution, trailing-slash
 * stripping, and bare `.` removal — all without touching the filesystem
 * or reading `process.cwd()` as long as `inputs.cwd` is itself absolute
 * (guaranteed by the caller, see the `LexicalInputs` doc above).
 *
 * Does NOT collapse `..` and does NOT resolve symlinks — see the module
 * comment for why both are the impure step's job in claim-key-resolve.ts.
 * Two lexically-different inputs that are the same real directory (a
 * symlink and its target, or a `..` that only resolves correctly with
 * filesystem knowledge) are NOT reconciled here.
 */
export function lexicallyNormalize(input: string, inputs: LexicalInputs): string {
  const expanded = expandHome(input, inputs.home);
  const absolute = toAbsolute(expanded, inputs.cwd);
  const segments = absolute.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  return `/${segments.join("/")}`;
}
