// Recursive, content-sensitive directory snapshot — the CORRECTED
// instrument for "nothing written into a claimed directory" (epic-wide
// correction to BAKR-17's own criterion 7, handed down 2026-09-11 after
// BAKR-18 demonstrated the gap: a directory's own mtime/ctime changes only
// when an entry is added, removed or renamed — NEVER when an existing
// file's bytes are rewritten under the same name. BAKR-16's own AC7
// evidence used the same blind technique and is treated as reduced-strength
// by the same correction; BAKR-21's item 7 demonstration matched exactly
// what criterion 7 specified at the time, so this is not a defect in that
// work — the instrument it was given could not see what the criterion
// claims.
//
// A recursive content hash closes the gap structurally: every file's
// relative path AND its exact bytes are hashed, so an in-place, same-name
// rewrite changes the result even though no directory entry moved, was
// added, or was removed. See test/unit/dir-snapshot.test.ts for the
// instrument's own positive controls (new file, dotfile, subdirectory,
// deletion, in-place rewrite, nested rewrite) and negative control.
//
// SCOPE, stated honestly rather than left implicit: this proves bakr's OWN
// launch/stop machinery wrote nothing into the directory. It says nothing
// about what a REAL agent's own conversation might legitimately write into
// the directory it is attached to — that is expected, ordinary use, not a
// violation of anything this product promises. The live demonstration this
// instrument backs launches agents with no prompt at all (B8), specifically
// so nothing exercises that path either, and the demo's own output states
// this scoping explicitly.

import { readFile, readdir, lstat, readlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";

interface Entry {
  readonly relPath: string;
  readonly kind: "file" | "dir" | "symlink";
  readonly content?: Buffer;
  readonly symlinkTarget?: string;
}

async function collect(root: string, dir: string, out: Entry[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = join(dir, entry.name);
    const relPath = relative(root, full);
    const st = await lstat(full);
    if (st.isSymbolicLink()) {
      const symlinkTarget = await readlink(full);
      out.push({ relPath, kind: "symlink", symlinkTarget });
    } else if (st.isDirectory()) {
      out.push({ relPath, kind: "dir" });
      await collect(root, full, out);
    } else if (st.isFile()) {
      const content = await readFile(full);
      out.push({ relPath, kind: "file", content });
    }
  }
}

/**
 * A single hash summarizing the recursive, content-sensitive state of
 * `dir`: every entry's relative path, kind, and (for files) exact byte
 * content, and (for symlinks) their target. Two snapshots are equal if and
 * only if nothing in the tree's structure OR any file's bytes changed —
 * including a same-name in-place rewrite, which a bare directory `stat`
 * cannot see (the gap this instrument exists to close).
 */
export async function snapshotDirectory(dir: string): Promise<string> {
  const entries: Entry[] = [];
  await collect(dir, dir, entries);
  const hash = createHash("sha256");
  for (const e of entries) {
    hash.update(e.relPath);
    hash.update("\0");
    hash.update(e.kind);
    hash.update("\0");
    if (e.kind === "file" && e.content !== undefined) hash.update(e.content);
    if (e.kind === "symlink" && e.symlinkTarget !== undefined) hash.update(e.symlinkTarget);
    hash.update("\0\0");
  }
  return hash.digest("hex");
}
