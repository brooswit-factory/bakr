// The impure edge of orphan classification (BAKR-24 Q1/Q2): the ONLY module
// in the orphan-detection path that touches the real filesystem. Produces
// plain data (`DirectoryProbe`) that orphan-model.ts's `classifyDirectory`
// (pure) turns into a verdict — the same pure/impure split this codebase
// already draws everywhere else (claim-key.ts/claim-key-resolve.ts,
// xdg.ts/paths.ts). `stat`/`lstat` are injected, never imported directly, so
// this module stays unit-testable with fakes.
//
// Deliberately `stat`, not `lstat`: Q1's rule cares whether the directory a
// claim names still RESOLVES (a symlink pointing at a real target still
// counts as present) — the claim key itself is already the symlink-resolved
// real path (claim-key-resolve.ts), so in the ordinary case this is moot,
// but a defensive `stat` (follows symlinks) rather than `lstat` (does not)
// is the correct primitive for "does this path resolve to something" either
// way.

export interface StatLike {
  readonly dev: number;
  readonly ino: number;
  readonly isDirectory: () => boolean;
}

export interface OrphanProbeDeps {
  readonly stat: (path: string) => Promise<StatLike>;
}

export type DirectoryProbe =
  | { readonly kind: "exists"; readonly device: number; readonly inode: number; readonly isDirectory: boolean }
  | { readonly kind: "enoent"; readonly ancestor: AncestorProbe | undefined }
  | { readonly kind: "stat-error"; readonly message: string };

export interface AncestorProbe {
  readonly path: string;
  /** `false` when this ancestor itself exists but could not be stat'd (e.g. EACCES on a parent directory) — distinct from "does not exist yet, keep walking up". */
  readonly readable: boolean;
  readonly device: number | undefined;
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "ENOENT";
}

function parentOf(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const lastSlash = trimmed.lastIndexOf("/");
  if (lastSlash <= 0) return "/";
  return trimmed.slice(0, lastSlash);
}

/**
 * Walks up from `dirname(path)` looking for the nearest ancestor that
 * exists. Stops the instant one is found (readable or not) — this is a
 * bounded walk in practice because the filesystem root always exists;
 * `path` must be absolute (the caller's job, same as claim-key-resolve.ts).
 */
async function findNearestExistingAncestor(path: string, deps: OrphanProbeDeps): Promise<AncestorProbe | undefined> {
  let current = parentOf(path);
  for (;;) {
    try {
      const stat = await deps.stat(current);
      return { path: current, readable: true, device: stat.dev };
    } catch (err) {
      if (isEnoent(err)) {
        const parent = parentOf(current);
        if (parent === current) return undefined; // reached "/" and even that ENOENTs — should not happen on a real filesystem
        current = parent;
        continue;
      }
      // Exists (traversal got this far) but couldn't be stat'd — e.g. EACCES on a parent directory's own permissions.
      return { path: current, readable: false, device: undefined };
    }
  }
}

/**
 * Probes `path` (must be absolute — an already-resolved `ClaimKey`, in
 * practice) and returns plain data for `classifyDirectory` (orphan-model.ts)
 * to turn into a verdict. Never throws.
 */
export async function probeDirectory(path: string, deps: OrphanProbeDeps): Promise<DirectoryProbe> {
  try {
    const stat = await deps.stat(path);
    return { kind: "exists", device: stat.dev, inode: stat.ino, isDirectory: stat.isDirectory() };
  } catch (err) {
    if (isEnoent(err)) {
      const ancestor = await findNearestExistingAncestor(path, deps);
      return { kind: "enoent", ancestor };
    }
    return { kind: "stat-error", message: err instanceof Error ? err.message : String(err) };
  }
}
