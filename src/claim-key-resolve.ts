// The impure half of claim-path normalization (BAKR-10). Takes `lstat` and
// `readlink` as parameters rather than reaching for `node:fs` itself, so
// this module stays unit-testable with fakes — the same pure/impure seam
// `brooswit-factory/candlestix` draws between `src/xdg.ts` (pure) and
// `src/paths.ts` (the one impure caller that reads real env/os once) —
// verified at candlestix's own commit before this was written; ported as
// a *pattern*, not literal code, since the inputs differ. paths.ts is the
// one real caller that wires real filesystem primitives in here.
//
// Why NOT `fs.realpath` (a correction to this module's own first draft):
// the obvious impure primitive to inject here is a single `realpath`
// function, and this module's first version did exactly that. It was
// wrong. Verified directly against this project's own runtime (bun
// 1.3.14, 2026-09-10) with a real fixture — a real directory
// `real-parent/child`, a real symlink `elsewhere/link -> real-parent/child`
// — and resolving `elsewhere/link/..`:
//   - GNU coreutils `realpath -e`  -> real-parent   (correct: POSIX walks
//     path components left to right, substitutes a symlink's target when
//     encountered, and applies a later `..` to the RESOLVED location, not
//     the lexical one)
//   - Python's `os.path.realpath` (glibc `realpath(3)`) -> real-parent
//   - Node 20's `fs.realpathSync.native` (glibc `realpath(3)`) -> real-parent
//   - Node 20's `fs.realpathSync` (Node's own JS re-implementation,
//     documented to diverge from native on this exact case) -> elsewhere
//   - **bun 1.3.14's `fs.promises.realpath`, AND its `fs.realpathSync.native`
//     — both -> elsewhere, i.e. WRONG, matching Node's non-native JS
//     quirk rather than glibc.** `node:fs/promises`'s `realpath` does not
//     even expose a `.native` escape hatch under bun (`typeof
//     realpath.native === "undefined"`, checked directly).
// This is exactly the trap this ticket's own steer calls out: "lexical
// `..` resolution is wrong in the presence of symlinks" — and it turns out
// bun's own realpath (both variants) makes that exact lexical mistake
// instead of the POSIX-correct one. A single injected `realpath` function
// cannot be trusted to get this right on this project's own runtime, so
// this module does the segment-by-segment walk itself — the standard
// realpath(3) algorithm — built on `lstat`/`readlink`, which are thin
// enough wrappers over simple syscalls that they were not found to have
// this class of bug (spot-checked against the same fixture; see
// test/integration/claim-key-resolve.test.ts for the reproduction).
//
// This is also why claim-key.ts's lexical step does NOT collapse `..`
// (only `.`): collapsing `..` before this walk runs would destroy the
// information this walk needs to get the symlink case right, regardless
// of which resolver eventually consumes it — the bug lives in resolving
// `..` before symlinks are known, not merely in which function happens to
// do that resolving.
//
// Stated limits, same as before: this module resolves the input to its
// real, symlink-free form. It does NOT verify the result is a directory
// rather than a regular file — that check is a policy question for
// bakr's caller, not this store, mirroring how "you cannot cd into a
// file" is enforced by the shell, not by `realpath` itself. Two Unicode
// spellings of the same name, or two names differing only in case, are
// two different directories to the kernel and are NOT reconciled here —
// Linux paths are byte strings and neither this walk nor glibc's
// `realpath(3)` normalizes either.

/**
 * An absolute, symlink-resolved path — the claim store's actual key.
 * Branded so an un-normalized string cannot be passed where a key belongs;
 * the only way to produce one is `resolveClaimKey` succeeding.
 */
export type ClaimKey = string & { readonly __claimKeyBrand: unique symbol };

export interface Lstat {
  isSymbolicLink(): boolean;
}

export interface ResolveInputs {
  /** Real filesystem primitives, injected so this module never reaches for `node:fs` itself. See paths.ts for the real caller. */
  readonly lstat: (path: string) => Promise<Lstat>;
  readonly readlink: (path: string) => Promise<string>;
}

export type ResolveResult =
  | { readonly ok: true; readonly key: ClaimKey }
  | { readonly ok: false; readonly reason: "does-not-exist"; readonly path: string }
  | { readonly ok: false; readonly reason: "resolve-failed"; readonly path: string; readonly message: string };

/** Matches glibc `realpath(3)`'s own `ELOOP` guard against a symlink cycle; not derived from any spec-mandated number. */
const MAX_SYMLINK_DEPTH = 40;

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "ENOENT";
}

function splitSegments(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

/**
 * The POSIX `realpath(3)` algorithm, spelled out by hand: walk the path
 * component by component, tracking a resolved (symlink-free) prefix. A
 * `..` pops the RESOLVED prefix, not the lexical one, so a `..` that
 * follows a symlink component correctly lands at the real parent of the
 * symlink's target — the exact case bun's own `realpath` gets wrong (see
 * module comment above). A symlink is substituted by its target and
 * re-walked: an absolute target restarts resolution from `/`, a relative
 * one continues from the current resolved prefix, matching what "resolve
 * relative to the symlink's containing directory" means.
 */
async function walk(absolutePath: string, inputs: ResolveInputs): Promise<string> {
  const remaining = splitSegments(absolutePath);
  let resolved = "";
  let linkDepth = 0;

  while (remaining.length > 0) {
    const segment = remaining.shift() as string;
    if (segment === ".") {
      continue;
    }
    if (segment === "..") {
      const lastSlash = resolved.lastIndexOf("/");
      resolved = lastSlash <= 0 ? "" : resolved.slice(0, lastSlash);
      continue;
    }

    const candidate = `${resolved}/${segment}`;
    const stat = await inputs.lstat(candidate);
    if (stat.isSymbolicLink()) {
      linkDepth += 1;
      if (linkDepth > MAX_SYMLINK_DEPTH) {
        throw new Error(`too many levels of symbolic links resolving "${candidate}"`);
      }
      const target = await inputs.readlink(candidate);
      if (target.startsWith("/")) {
        resolved = "";
      }
      remaining.unshift(...splitSegments(target));
    } else {
      resolved = candidate;
    }
  }

  return resolved.length > 0 ? resolved : "/";
}

/**
 * `lexicalPath` must already be absolute (see `claim-key.ts`'s
 * `lexicallyNormalize`) — this module does not derive an absolute path
 * from a `cwd` itself, that is the earlier pure step's job. It may still
 * contain `..` segments: unlike the old realpath-as-parameter design, this
 * walk needs them intact to resolve symlinks correctly (see module
 * comment). Two lexically different inputs whose real resolution agrees
 * (a symlink and its target, a path with a trailing slash, a path with
 * `..` segments — even ones that traverse a symlink) resolve to the
 * identical `ClaimKey` — that convergence is exactly what makes "two
 * spellings of one directory must not produce two claims" true.
 */
export async function resolveClaimKey(lexicalPath: string, inputs: ResolveInputs): Promise<ResolveResult> {
  try {
    const real = await walk(lexicalPath, inputs);
    return { ok: true, key: real as ClaimKey };
  } catch (err) {
    if (isEnoent(err)) {
      return { ok: false, reason: "does-not-exist", path: lexicalPath };
    }
    return {
      ok: false,
      reason: "resolve-failed",
      path: lexicalPath,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
