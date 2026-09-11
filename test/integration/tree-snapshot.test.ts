// Proves the DoD #7 instrument (fixtures/tree-snapshot.ts) actually works
// BEFORE trusting it in adopt.test.ts — "an instrument without its own
// positive controls is decoration" (BAKR-24, [CORRECTED] DoD #7). Each
// positive control is a specific mutation the probe MUST detect; each
// negative control is something that must leave it quiet.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotTree, diffTreeSnapshots } from "./fixtures/tree-snapshot";

const cleanupDirs: string[] = [];
afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function makeFixtureTree(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bakr-tree-snapshot-"));
  cleanupDirs.push(dir);
  await writeFile(join(dir, "top.txt"), "top-level content", "utf8");
  await mkdir(join(dir, "nested"));
  await writeFile(join(dir, "nested", "inner.txt"), "nested content", "utf8");
  return dir;
}

describe("tree-snapshot instrument: negative controls (must stay quiet)", () => {
  test("no change at all", async () => {
    const dir = await makeFixtureTree();
    const before = await snapshotTree(dir);
    const after = await snapshotTree(dir);
    const diff = diffTreeSnapshots(before, after);
    expect(diff).toEqual({ changed: false, details: [] });
  });

  test("read-only access (reading file contents) reports no change", async () => {
    const dir = await makeFixtureTree();
    const before = await snapshotTree(dir);
    await readFile(join(dir, "top.txt"));
    await readFile(join(dir, "nested", "inner.txt"));
    const after = await snapshotTree(dir);
    expect(diffTreeSnapshots(before, after)).toEqual({ changed: false, details: [] });
  });
});

describe("tree-snapshot instrument: positive controls (each MUST be detected)", () => {
  test("a new top-level file is detected", async () => {
    const dir = await makeFixtureTree();
    const before = await snapshotTree(dir);
    await writeFile(join(dir, "new-file.txt"), "surprise", "utf8");
    const diff = diffTreeSnapshots(before, await snapshotTree(dir));
    expect(diff.changed).toBe(true);
    expect(diff.details.some((d) => d.includes("file added: new-file.txt"))).toBe(true);
  });

  test("a new DOTFILE is detected — readdir must not silently skip it", async () => {
    const dir = await makeFixtureTree();
    const before = await snapshotTree(dir);
    await writeFile(join(dir, ".hidden"), "surprise", "utf8");
    const diff = diffTreeSnapshots(before, await snapshotTree(dir));
    expect(diff.changed).toBe(true);
    expect(diff.details.some((d) => d.includes("file added: .hidden"))).toBe(true);
  });

  test("a new subdirectory is detected", async () => {
    const dir = await makeFixtureTree();
    const before = await snapshotTree(dir);
    await mkdir(join(dir, "new-subdir"));
    const diff = diffTreeSnapshots(before, await snapshotTree(dir));
    expect(diff.changed).toBe(true);
    expect(diff.details.some((d) => d.includes("directory added: new-subdir"))).toBe(true);
  });

  test("a deletion is detected", async () => {
    const dir = await makeFixtureTree();
    const before = await snapshotTree(dir);
    await rm(join(dir, "top.txt"));
    const diff = diffTreeSnapshots(before, await snapshotTree(dir));
    expect(diff.changed).toBe(true);
    expect(diff.details.some((d) => d.includes("file removed: top.txt"))).toBe(true);
  });

  test("THE MEASURED BLIND SPOT: rewriting a TOP-LEVEL file's content IN PLACE, with its mtime reset back to the ORIGINAL value, is still detected by content hashing — proving this probe does not depend on mtime moving at all", async () => {
    const dir = await makeFixtureTree();
    const path = join(dir, "top.txt");
    const before = await snapshotTree(dir);
    const originalStat = await stat(path);

    await writeFile(path, "REWRITTEN content, same name, different bytes", "utf8");
    // Reset the file's mtime/atime back to (within JS Date's millisecond
    // precision of) the pre-write values — this is exactly the scenario the
    // ticket measured: a rewrite whose PARENT DIRECTORY's own mtime never
    // moves at all for an in-place rewrite (entries didn't change), so an
    // mtime-only probe of the directory gives no signal.
    await utimes(path, originalStat.atime, originalStat.mtime);

    const after = await snapshotTree(dir);
    // The measured blind spot itself: the directory's own mtime/ctime did NOT move.
    expect(after.ownMtimeMs).toBe(before.ownMtimeMs);
    expect(after.ownCtimeMs).toBe(before.ownCtimeMs);

    const diff = diffTreeSnapshots(before, after);
    expect(diff.changed).toBe(true);
    expect(diff.details.some((d) => d.includes("file CONTENT CHANGED: top.txt"))).toBe(true);
  });

  test("the same measured blind spot, for a NESTED file", async () => {
    const dir = await makeFixtureTree();
    const path = join(dir, "nested", "inner.txt");
    const before = await snapshotTree(dir);
    const originalStat = await stat(path);

    await writeFile(path, "REWRITTEN nested content", "utf8");
    await utimes(path, originalStat.atime, originalStat.mtime);

    const after = await snapshotTree(dir);
    // The root directory's own mtime is unaffected by a rewrite two levels down, and the immediate parent ("nested")'s mtime is unaffected too — neither directory's entries changed.
    expect(after.ownMtimeMs).toBe(before.ownMtimeMs);
    expect(after.dirs.get("nested")?.mtimeMs).toBe(before.dirs.get("nested")?.mtimeMs);

    const diff = diffTreeSnapshots(before, after);
    expect(diff.changed).toBe(true);
    expect(diff.details.some((d) => d.includes(`file CONTENT CHANGED: ${join("nested", "inner.txt")}`))).toBe(true);
  });
});
