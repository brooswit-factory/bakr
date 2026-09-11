// A CONTENT-SENSITIVE, RECURSIVE directory snapshot (BAKR-24 DoD #7,
// [CORRECTED]). The obvious probe — a directory's own mtime/ctime plus its
// entry names — is NOT sufficient, measured rather than assumed: a
// directory's mtime moves only when an entry is added, removed or renamed;
// REWRITING an existing file's content under the same name is invisible to
// it. This probe hashes every file's actual bytes, so a content rewrite is
// caught regardless of whether mtime moved at all (a rewrite that also
// resets its own mtime back to the original value — exactly the case the
// weaker probe was measured blind to — is proven caught by this file's own
// test, test/integration/tree-snapshot.test.ts).

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export interface TreeSnapshot {
  readonly ownMtimeMs: number;
  readonly ownCtimeMs: number;
  /** relative path -> sha256 hex digest of the file's content, plus its own mtime (recorded, but never relied on alone). */
  readonly files: ReadonlyMap<string, { readonly hash: string; readonly mtimeMs: number }>;
  /** relative path -> the subdirectory's own mtime/ctime. */
  readonly dirs: ReadonlyMap<string, { readonly mtimeMs: number; readonly ctimeMs: number }>;
}

/** Recursively snapshots `root`. Regular files and directories only — a symlink or other special file inside the tree is out of this probe's scope. */
export async function snapshotTree(root: string): Promise<TreeSnapshot> {
  const own = await stat(root);
  const files = new Map<string, { hash: string; mtimeMs: number }>();
  const dirs = new Map<string, { mtimeMs: number; ctimeMs: number }>();

  async function walk(relDir: string): Promise<void> {
    const absDir = relDir ? join(root, relDir) : root;
    const entries = await readdir(absDir, { withFileTypes: true });
    for (const entry of entries) {
      const relPath = relDir ? join(relDir, entry.name) : entry.name;
      const absPath = join(root, relPath);
      if (entry.isDirectory()) {
        const s = await stat(absPath);
        dirs.set(relPath, { mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs });
        await walk(relPath);
      } else if (entry.isFile()) {
        const content = await readFile(absPath);
        const hash = createHash("sha256").update(content).digest("hex");
        const s = await stat(absPath);
        files.set(relPath, { hash, mtimeMs: s.mtimeMs });
      }
    }
  }
  await walk("");

  return { ownMtimeMs: own.mtimeMs, ownCtimeMs: own.ctimeMs, files, dirs };
}

export interface TreeDiff {
  readonly changed: boolean;
  /** One human-readable line per detected difference — empty when `changed` is false. */
  readonly details: readonly string[];
}

/** Content-sensitive diff: a file's `hash` mismatch is what actually catches an in-place rewrite (mtime is recorded but never the deciding signal). */
export function diffTreeSnapshots(before: TreeSnapshot, after: TreeSnapshot): TreeDiff {
  const details: string[] = [];
  if (before.ownMtimeMs !== after.ownMtimeMs || before.ownCtimeMs !== after.ownCtimeMs) {
    details.push(`root directory's own mtime/ctime changed (${before.ownMtimeMs}/${before.ownCtimeMs} -> ${after.ownMtimeMs}/${after.ownCtimeMs})`);
  }

  const allFilePaths = new Set([...before.files.keys(), ...after.files.keys()]);
  for (const p of allFilePaths) {
    const b = before.files.get(p);
    const a = after.files.get(p);
    if (b === undefined && a !== undefined) details.push(`file added: ${p}`);
    else if (b !== undefined && a === undefined) details.push(`file removed: ${p}`);
    else if (b !== undefined && a !== undefined && b.hash !== a.hash) details.push(`file CONTENT CHANGED: ${p} (hash ${b.hash.slice(0, 8)} -> ${a.hash.slice(0, 8)}, mtime ${b.mtimeMs} -> ${a.mtimeMs})`);
  }

  const allDirPaths = new Set([...before.dirs.keys(), ...after.dirs.keys()]);
  for (const p of allDirPaths) {
    const b = before.dirs.get(p);
    const a = after.dirs.get(p);
    if (b === undefined && a !== undefined) details.push(`directory added: ${p}`);
    else if (b !== undefined && a === undefined) details.push(`directory removed: ${p}`);
  }

  return { changed: details.length > 0, details };
}
