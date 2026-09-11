// The corrected criterion-7 instrument's own positive and negative
// controls (epic-wide correction, 2026-09-11): an instrument that cannot
// be shown to detect each of these proves nothing by later reporting "no
// change". Falsifier for EVERY positive-control test: if `snapshotDirectory`
// returns the SAME hash before and after the described mutation, the
// instrument has the exact blind spot this correction exists to close.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotDirectory } from "../../scripts/dir-snapshot";

const cleanupDirs: string[] = [];
afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bakr-dir-snapshot-"));
  cleanupDirs.push(dir);
  return dir;
}

describe("snapshotDirectory — positive controls (each mutation MUST be detected)", () => {
  test("NEGATIVE CONTROL: an untouched directory reports NO change — the baseline every positive control is contrasted against", async () => {
    const dir = await makeDir();
    await writeFile(join(dir, "a.txt"), "hello");
    const before = await snapshotDirectory(dir);
    const after = await snapshotDirectory(dir);
    expect(after).toBe(before);
  });

  test("new file added", async () => {
    const dir = await makeDir();
    const before = await snapshotDirectory(dir);
    await writeFile(join(dir, "new.txt"), "content");
    const after = await snapshotDirectory(dir);
    expect(after).not.toBe(before);
  });

  test("new DOTFILE added (easy to forget — dotfiles are not special-cased and must still be detected)", async () => {
    const dir = await makeDir();
    const before = await snapshotDirectory(dir);
    await writeFile(join(dir, ".hidden"), "content");
    const after = await snapshotDirectory(dir);
    expect(after).not.toBe(before);
  });

  test("new subdirectory added", async () => {
    const dir = await makeDir();
    const before = await snapshotDirectory(dir);
    await mkdir(join(dir, "subdir"));
    const after = await snapshotDirectory(dir);
    expect(after).not.toBe(before);
  });

  test("a file deleted", async () => {
    const dir = await makeDir();
    await writeFile(join(dir, "gone.txt"), "bye");
    const before = await snapshotDirectory(dir);
    await rm(join(dir, "gone.txt"));
    const after = await snapshotDirectory(dir);
    expect(after).not.toBe(before);
  });

  test("THE GAP THIS INSTRUMENT EXISTS TO CLOSE: an existing file's content rewritten UNDER THE SAME NAME — a directory mtime/ctime/entries check cannot see this at all", async () => {
    const dir = await makeDir();
    await writeFile(join(dir, "same-name.txt"), "original content");
    const before = await snapshotDirectory(dir);
    await writeFile(join(dir, "same-name.txt"), "REWRITTEN content, same name, same size class");
    const after = await snapshotDirectory(dir);
    expect(after).not.toBe(before);
  });

  test("a NESTED file's content rewritten under the same name, inside a subdirectory", async () => {
    const dir = await makeDir();
    await mkdir(join(dir, "nested"));
    await writeFile(join(dir, "nested", "inner.txt"), "original");
    const before = await snapshotDirectory(dir);
    await writeFile(join(dir, "nested", "inner.txt"), "rewritten");
    const after = await snapshotDirectory(dir);
    expect(after).not.toBe(before);
  });

  test("a symlink's target changing is also detected", async () => {
    const dir = await makeDir();
    await writeFile(join(dir, "target-a.txt"), "a");
    await writeFile(join(dir, "target-b.txt"), "b");
    await symlink(join(dir, "target-a.txt"), join(dir, "link"));
    const before = await snapshotDirectory(dir);
    await rm(join(dir, "link"));
    await symlink(join(dir, "target-b.txt"), join(dir, "link"));
    const after = await snapshotDirectory(dir);
    expect(after).not.toBe(before);
  });
});
