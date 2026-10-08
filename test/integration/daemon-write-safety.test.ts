// "Nothing is written inside a claimed directory" (BAKR-8 definition of
// done), extended to the daemon's own full reconcile cycle INCLUDING a
// restore — the case demonstration #3 in the ticket specifically asks for,
// distinct from claim-store-write-safety.test.ts (BAKR-10), which covers
// only claim/persist/reload/release with no daemon and no restore
// involved.
//
// Also closes the gap the ticket names explicitly: BAKR-6's own
// write-safety test snapshots the entries WITHIN a claimed directory and
// stats each one, but never stats the directory itself — so a
// create-then-delete inside it during the window under test would leave no
// trace in what that suite samples. This file stats the directory's own
// mtime/ctime in addition to its entries, closing that specific hole for
// the daemon's own cycle.
//
// FACTORY-150: the mtime-only probe this file used to carry (stat the
// directory's own mtime/ctime, plus each entry's mtime) is itself measured
// insufficient — rewriting an existing file's CONTENT under the same name
// moves neither the parent directory's mtime nor necessarily the file's
// own mtime (a rewrite can reset its mtime back to the original value).
// BAKR-24 built a content-hashing instrument for exactly this
// (fixtures/tree-snapshot.ts) with its own positive/negative controls
// (tree-snapshot.test.ts) proving it catches that in-place rewrite where
// the mtime-only probe stays blind. This file now uses that instrument
// instead of its own weaker one.
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claim, emptyStore } from "../../src/claim-model";
import { save as saveClaims } from "../../src/claim-store-io";
import { lexicallyNormalize } from "../../src/claim-key";
import { resolveClaimKey } from "../../src/claim-key-resolve";
import { realResolveInputs, realOrphanProbeDeps } from "../../src/paths";
import { beginLaunch, emptySessionSlots, markLaunchStarted, resolveLaunch } from "../../src/session-slots";
import { save as saveSlots } from "../../src/session-slots-store";
import { initialDaemonState, runReconcileCycle, type DaemonDeps } from "../../src/daemon";
import { makeFakeHost } from "../support/fake-host";
import { snapshotTree, diffTreeSnapshots } from "./fixtures/tree-snapshot";

const cleanupDirs: string[] = [];
const pendingChmodRestores: Array<{ path: string; mode: number }> = [];

afterEach(async () => {
  while (pendingChmodRestores.length > 0) {
    const entry = pendingChmodRestores.pop();
    if (entry) await chmod(entry.path, entry.mode).catch(() => {});
  }
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

async function seedClaimedDirContents(dir: string): Promise<void> {
  await writeFile(join(dir, "README.md"), "hello\n", "utf8");
  await mkdir(join(dir, "src"));
  await writeFile(join(dir, "src", "index.ts"), "export {}\n", "utf8");
}

/** Content-sensitive: a diff with no details means not even an in-place content rewrite happened, not just that entries/mtimes look the same. */
function expectUnchanged(before: Awaited<ReturnType<typeof snapshotTree>>, after: Awaited<ReturnType<typeof snapshotTree>>): void {
  expect(diffTreeSnapshots(before, after)).toEqual({ changed: false, details: [] });
}

/**
 * The shared herdr + legacy-claude fake (test/support/fake-host.ts). It
 * touches no filesystem, so any change inside the claimed directory is bakr's
 * own. Nothing is running at the start of the cycle, which forces a restore:
 * an agent that already has a `restoreTarget` (as this file's migrated seed
 * does) is resumed (`--resume <sessionId>`) in a new pane rooted at its
 * directory. launch-config is NOT stubbed: it reads the claimed directory's
 * real (absent) `.mcp.json`, so no MCP approval is due and none may be
 * written there.
 */
const fakeHost = () => makeFakeHost();

/** The restore really happened: exactly one resume of the seeded session, in a pane rooted at the claimed directory. */
function expectRestoredInto(host: ReturnType<typeof fakeHost>, key: string): void {
  expect(host.starts()).toEqual([["--resume", "session-to-restore"]]);
  expect(host.panes.map((p) => p.cwd)).toEqual([key]);
}

describe("nothing is written inside a claimed directory across a full daemon cycle, including a restore", () => {
  test("refuses to run under uid 0 — root bypasses permission bits, which would make the chmod-0555 half below pass vacuously", () => {
    const uid = process.getuid ? process.getuid() : undefined;
    if (uid === 0) {
      throw new Error("running as root — the chmod-0555 half is vacuous under root; re-run as a non-root user.");
    }
    expect(uid).not.toBe(0);
  });

  test("LOAD-BEARING: a writable claimed directory is entry-for-entry AND directory-mtime-for-directory-mtime identical after a restore cycle", async () => {
    const claimedDir = await makeTempDir("bakr-daemon-write-safety-writable-");
    await seedClaimedDirContents(claimedDir);
    const storeDir = await makeTempDir("bakr-daemon-write-safety-store-");

    const lexical = lexicallyNormalize(claimedDir, { cwd: claimedDir, home: claimedDir });
    const resolved = await resolveClaimKey(lexical, realResolveInputs);
    if (!resolved.ok) throw new Error(`test setup failure resolving claimed dir: ${JSON.stringify(resolved)}`);

    await saveClaims(join(storeDir, "claims.json"), claim(emptyStore(), resolved.key, Date.now()).state);
    let slots = emptySessionSlots();
    slots = beginLaunch(slots, resolved.key, undefined, "seed-attempt", 1);
    slots = markLaunchStarted(slots, "seed-attempt", "seed-short");
    slots = resolveLaunch(slots, "seed-short", "session-to-restore");
    await saveSlots(join(storeDir, "session-slots.json"), slots);

    const host = fakeHost();
    const deps: DaemonDeps = {
      runCommand: host.runCommand,
      claimsPath: join(storeDir, "claims.json"),
      agentsPath: join(storeDir, "agents.json"),
      sessionSlotsPath: join(storeDir, "session-slots.json"),
      now: () => Date.now(),
      generateAttemptId: () => "restore-attempt",
      randomBytes: (n: number) => new Uint8Array(n).fill(0x42),
      probeDeps: realOrphanProbeDeps,
    };

    const before = await snapshotTree(claimedDir);
    const result = await runReconcileCycle(initialDaemonState(), deps);
    expect(result.restored).toHaveLength(1); // confirms a restore genuinely happened, not a vacuous pass
    expectRestoredInto(host, resolved.key);
    const after = await snapshotTree(claimedDir);

    expectUnchanged(before, after);
  });

  test("BELT: the identical restore cycle against a chmod 0555 (read-only) claimed directory still succeeds and still leaves it unchanged", async () => {
    const uid = process.getuid ? process.getuid() : undefined;
    if (uid === 0) throw new Error("running as root — vacuous, see the dedicated uid-0 test above.");

    const claimedDir = await makeTempDir("bakr-daemon-write-safety-readonly-");
    await seedClaimedDirContents(claimedDir);

    const lexical = lexicallyNormalize(claimedDir, { cwd: claimedDir, home: claimedDir });
    const resolved = await resolveClaimKey(lexical, realResolveInputs);
    if (!resolved.ok) throw new Error(`test setup failure resolving claimed dir: ${JSON.stringify(resolved)}`);

    const storeDir = await makeTempDir("bakr-daemon-write-safety-store-");
    await saveClaims(join(storeDir, "claims.json"), claim(emptyStore(), resolved.key, Date.now()).state);
    let slots = emptySessionSlots();
    slots = beginLaunch(slots, resolved.key, undefined, "seed-attempt", 1);
    slots = markLaunchStarted(slots, "seed-attempt", "seed-short");
    slots = resolveLaunch(slots, "seed-short", "session-to-restore");
    await saveSlots(join(storeDir, "session-slots.json"), slots);

    await chmod(claimedDir, 0o555);
    pendingChmodRestores.push({ path: claimedDir, mode: 0o755 });
    // Baseline taken AFTER chmod: chmod itself changes the directory's own
    // ctime, which is not bakr's doing — comparing from here isolates
    // exactly what the reconcile cycle itself does to the directory.
    const before = await snapshotTree(claimedDir);

    const host = fakeHost();
    const deps: DaemonDeps = {
      runCommand: host.runCommand,
      claimsPath: join(storeDir, "claims.json"),
      agentsPath: join(storeDir, "agents.json"),
      sessionSlotsPath: join(storeDir, "session-slots.json"),
      now: () => Date.now(),
      generateAttemptId: () => "restore-attempt",
      randomBytes: (n: number) => new Uint8Array(n).fill(0x42),
      probeDeps: realOrphanProbeDeps,
    };

    // Any write attempt into claimedDir from here on would throw EACCES and fail this test outright.
    const result = await runReconcileCycle(initialDaemonState(), deps);
    expect(result.restored).toHaveLength(1);
    expectRestoredInto(host, resolved.key);

    // Snapshot BEFORE restoring permissions — chmod itself changes the
    // directory's own ctime, and that must not be mistaken for a write
    // bakr made. Permissions are restored afterward, purely for the
    // recursive rm in afterEach to succeed.
    const after = await snapshotTree(claimedDir);
    await chmod(claimedDir, 0o755);

    expectUnchanged(before, after);
  });
});
