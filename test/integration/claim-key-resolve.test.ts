// Real-filesystem integration test for resolveClaimKey, wired to the real
// `lstat`/`readlink` (see src/paths.ts) rather than fakes — the unit test
// in test/unit/claim-key-resolve.test.ts covers the logic with fakes;
// this proves it against actual symlinks, actual `..`, and an actual
// trailing slash, which a fake cannot.
//
// The second test below is the reproduction for a real bug found while
// building this ticket: bun 1.3.14's OWN `fs.promises.realpath` (and its
// `fs.realpathSync.native`) resolves `..` after a symlink INCORRECTLY —
// it lands where the symlink's lexical location would put it, not where
// POSIX (glibc `realpath(3)`, GNU coreutils `realpath -e`, Python's
// `os.path.realpath`, Node 20's `fs.realpathSync.native`) says it should.
// That is why claim-key-resolve.ts does its own segment-by-segment walk
// on `lstat`/`readlink` instead of trusting a single injected `realpath`
// — this test is what would fail if that walk regressed to reproduce
// bun's bug.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realResolveInputs } from "../../src/paths";
import { resolveClaimKey } from "../../src/claim-key-resolve";
import { lexicallyNormalize } from "../../src/claim-key";

const cleanupDirs: string[] = [];

afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bakr-claim-key-resolve-"));
  cleanupDirs.push(dir);
  return dir;
}

describe("resolveClaimKey against the real filesystem", () => {
  test("a symlink and its target — two genuinely different spellings of one directory — resolve to the SAME ClaimKey", async () => {
    const root = await makeTempDir();
    const target = join(root, "real-dir");
    await mkdir(target);
    const link = join(root, "the-link");
    await symlink(target, link);

    const viaTarget = await resolveClaimKey(lexicallyNormalize(target, { cwd: root, home: root }), realResolveInputs);
    const viaLink = await resolveClaimKey(lexicallyNormalize(link, { cwd: root, home: root }), realResolveInputs);

    expect(viaTarget.ok).toBe(true);
    expect(viaLink.ok).toBe(true);
    if (viaTarget.ok && viaLink.ok) {
      expect(viaLink.key).toBe(viaTarget.key);
    }
  });

  test("`..` through a symlink resolves to the link's real parent, not its lexical parent — the case bun's own realpath gets wrong", async () => {
    const root = await makeTempDir();
    const realParent = join(root, "real-parent");
    const realChild = join(realParent, "child");
    await mkdir(realChild, { recursive: true });

    const linkDir = join(root, "elsewhere");
    await mkdir(linkDir);
    const link = join(linkDir, "link-to-child");
    await symlink(realChild, link);

    // lexicallyNormalize deliberately does NOT collapse `..` (see its own
    // module comment) — it must reach resolveClaimKey's walk intact, with
    // `link-to-child/..` still in it, for the walk to correctly land at
    // real-parent instead of at elsewhere (the lexical, wrong, answer).
    // Built with raw string concatenation, NOT `path.join`/`path.resolve`
    // — both of those collapse `..` lexically themselves, which would
    // destroy the very thing this test is set up to preserve.
    const lexicalDotDot = lexicallyNormalize(`${link}/..`, { cwd: root, home: root });
    expect(lexicalDotDot).toBe(`${link}/..`);

    const viaDotDot = await resolveClaimKey(lexicalDotDot, realResolveInputs);
    const viaRealParent = await resolveClaimKey(lexicallyNormalize(realParent, { cwd: root, home: root }), realResolveInputs);

    expect(viaDotDot.ok).toBe(true);
    expect(viaRealParent.ok).toBe(true);
    if (viaDotDot.ok && viaRealParent.ok) {
      expect(viaDotDot.key).toBe(viaRealParent.key);
      expect(viaDotDot.key).not.toBe(join(linkDir, ".."));
    }
  });

  test("a trailing slash does not change the resolved key", async () => {
    const root = await makeTempDir();
    const dir = join(root, "d");
    await mkdir(dir);

    const withSlash = await resolveClaimKey(lexicallyNormalize(`${dir}/`, { cwd: root, home: root }), realResolveInputs);
    const without = await resolveClaimKey(lexicallyNormalize(dir, { cwd: root, home: root }), realResolveInputs);

    expect(withSlash.ok).toBe(true);
    expect(without.ok).toBe(true);
    if (withSlash.ok && without.ok) {
      expect(withSlash.key).toBe(without.key);
    }
  });

  test("a path that does not exist on the real filesystem is a typed 'does-not-exist' refusal", async () => {
    const root = await makeTempDir();
    const missing = join(root, "never-created");
    const result = await resolveClaimKey(missing, realResolveInputs);
    expect(result).toEqual({ ok: false, reason: "does-not-exist", path: missing });
  });
});
