// The combined "nothing whatsoever is written inside a claimed directory"
// demonstration (BAKR-10 definition of done, §4(a)). This ticket's own
// correction on this point (see the ticket's `[correction]` comment) is
// the reason this file has the shape it has: the two halves below are ONE
// check, not two independent proofs.
//
// - The LOAD-BEARING half runs the full cycle against a normally WRITABLE
//   directory and snapshots its full recursive contents AND every entry's
//   mtime before and after. This is the half that actually closes the
//   hole: code that attempts a write and swallows the failure (e.g.
//   catches EACCES and carries on) would pass a read-only-directory check
//   vacuously, because the attempt would fail there regardless of intent.
//   Here, a real attempt would actually succeed and show up as a new
//   entry or a changed mtime.
// - The BELT re-runs the identical cycle against a `chmod 0555` directory,
//   adding the guarantee that no code path even needs write permission.
// - uid 0 makes the belt vacuous (root bypasses permission bits), so this
//   suite refuses loudly rather than passing silently under root.
//
// The claim store's own bookkeeping file lives in a SEPARATE temp
// directory in every test below, never inside the claimed directory
// itself — that separation is exactly decision #2 from the ticket ("state
// lives in the daemon's store, keyed by absolute path; nothing is written
// into the working tree") and this file is what demonstrates it rather
// than asserting it.
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claim, emptyStore, release } from "../../src/claim-model";
import { load, save } from "../../src/claim-store-io";
import { lexicallyNormalize } from "../../src/claim-key";
import { resolveClaimKey } from "../../src/claim-key-resolve";
import { realResolveInputs } from "../../src/paths";

const cleanupDirs: string[] = [];
const pendingChmodRestores: Array<{ path: string; mode: number }> = [];

afterEach(async () => {
  while (pendingChmodRestores.length > 0) {
    const entry = pendingChmodRestores.pop();
    if (entry) {
      await chmod(entry.path, entry.mode).catch(() => {});
    }
  }
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

/** A representative claimed directory: files at top level, plus a nested subdirectory, so "full recursive contents" means something. */
async function seedClaimedDirContents(dir: string): Promise<void> {
  await writeFile(join(dir, "README.md"), "hello\n", "utf8");
  await writeFile(join(dir, ".gitignore"), "node_modules\n", "utf8");
  await mkdir(join(dir, "src"));
  await writeFile(join(dir, "src", "index.ts"), "export {}\n", "utf8");
}

interface DirSnapshot {
  readonly entries: readonly string[];
  readonly mtimes: ReadonlyMap<string, number>;
}

async function snapshotDir(dir: string): Promise<DirSnapshot> {
  const entries = [...(await readdir(dir, { recursive: true }))].sort();
  const mtimes = new Map<string, number>();
  for (const rel of entries) {
    const st = await stat(join(dir, rel));
    mtimes.set(rel, st.mtimeMs);
  }
  return { entries, mtimes };
}

function expectDirUnchanged(before: DirSnapshot, after: DirSnapshot): void {
  expect(after.entries).toEqual(before.entries);
  for (const rel of before.entries) {
    expect(after.mtimes.get(rel)).toBe(before.mtimes.get(rel));
  }
}

/**
 * A complete claim -> persist -> reload -> release cycle. `storeDir` (never
 * `claimedDir`) is where the claim store's own bookkeeping file lives —
 * the whole point being that `claimedDir` never appears as a write target
 * anywhere in this function.
 */
async function runFullCycle(claimedDir: string, storeDir: string): Promise<void> {
  const claimsPath = join(storeDir, "claims.json");
  const lexical = lexicallyNormalize(claimedDir, { cwd: claimedDir, home: claimedDir });
  const resolved = await resolveClaimKey(lexical, realResolveInputs);
  if (!resolved.ok) {
    throw new Error(`test setup failure: could not resolve the claimed directory itself: ${JSON.stringify(resolved)}`);
  }

  const { state: afterClaim } = claim(emptyStore(), resolved.key, Date.now());
  await save(claimsPath, afterClaim);

  const loaded = await load(claimsPath);
  if (loaded.status !== "loaded") {
    throw new Error(`test setup failure: expected the store to reload as 'loaded', got '${loaded.status}'`);
  }

  const afterRelease = release(loaded.state, resolved.key);
  await save(claimsPath, afterRelease);
}

describe("nothing is written inside a claimed directory (combined check)", () => {
  test("refuses to run under uid 0 — root bypasses permission bits, which would make the chmod-0555 half below pass vacuously", () => {
    const uid = process.getuid ? process.getuid() : undefined;
    if (uid === 0) {
      throw new Error(
        "This suite is running as uid 0 (root). Root bypasses directory permission bits entirely, so the chmod-0555 half of this check would pass even if bakr attempted (and 'succeeded' at) writing into the claimed directory. A test that cannot tell it is running as root is worse than no test — re-run this suite as a non-root user.",
      );
    }
    expect(uid).not.toBe(0);
  });

  test("LOAD-BEARING: a full claim/persist/reload/release cycle against a normally WRITABLE claimed directory leaves it entry-for-entry and mtime-for-mtime identical", async () => {
    const claimedDir = await makeTempDir("bakr-write-safety-writable-");
    await seedClaimedDirContents(claimedDir);
    const storeDir = await makeTempDir("bakr-write-safety-store-");

    const before = await snapshotDir(claimedDir);
    await runFullCycle(claimedDir, storeDir);
    const after = await snapshotDir(claimedDir);

    expectDirUnchanged(before, after);
  });

  test("BELT: the identical cycle against a chmod 0555 (read-only) claimed directory still succeeds and still leaves it unchanged", async () => {
    const uid = process.getuid ? process.getuid() : undefined;
    if (uid === 0) {
      throw new Error("running as root — this half is vacuous under root (see the dedicated uid-0 test above) and must not be trusted here.");
    }

    const claimedDir = await makeTempDir("bakr-write-safety-readonly-");
    await seedClaimedDirContents(claimedDir);
    const before = await snapshotDir(claimedDir);

    await chmod(claimedDir, 0o555);
    pendingChmodRestores.push({ path: claimedDir, mode: 0o755 });

    const storeDir = await makeTempDir("bakr-write-safety-store-");
    // Any write attempt into claimedDir from here on would throw EACCES
    // and fail this test outright — that is the entire point of this half.
    await runFullCycle(claimedDir, storeDir);

    await chmod(claimedDir, 0o755); // restore before the recursive rm in afterEach
    const after = await snapshotDir(claimedDir);

    expectDirUnchanged(before, after);
  });
});
