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
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claim, emptyStore } from "../../src/claim-model";
import { save as saveClaims } from "../../src/claim-store-io";
import { lexicallyNormalize } from "../../src/claim-key";
import { resolveClaimKey } from "../../src/claim-key-resolve";
import { realResolveInputs } from "../../src/paths";
import { beginLaunch, emptySessionSlots, markLaunchStarted, resolveLaunch } from "../../src/session-slots";
import { save as saveSlots } from "../../src/session-slots-store";
import { initialDaemonState, runReconcileCycle, type DaemonDeps } from "../../src/daemon";
import type { RunCommandOptions, CommandResult } from "../../src/spawn";

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

interface Snapshot {
  readonly ownStat: { readonly mtimeMs: number; readonly ctimeMs: number };
  readonly entries: readonly string[];
  readonly entryMtimes: ReadonlyMap<string, number>;
}

/** Stats the directory ITSELF (the gap this file exists to close) in addition to every entry within it. */
async function snapshot(dir: string): Promise<Snapshot> {
  const own = await stat(dir);
  const entries = [...(await readdir(dir, { recursive: true }))].sort();
  const entryMtimes = new Map<string, number>();
  for (const rel of entries) {
    entryMtimes.set(rel, (await stat(join(dir, rel))).mtimeMs);
  }
  return { ownStat: { mtimeMs: own.mtimeMs, ctimeMs: own.ctimeMs }, entries, entryMtimes };
}

function expectUnchanged(before: Snapshot, after: Snapshot): void {
  expect(after.ownStat).toEqual(before.ownStat);
  expect(after.entries).toEqual(before.entries);
  for (const rel of before.entries) {
    expect(after.entryMtimes.get(rel)).toBe(before.entryMtimes.get(rel));
  }
}

function fakeRunCommand(): (argv: string[], opts: RunCommandOptions) => Promise<CommandResult> {
  let n = 0;
  return async (argv) => {
    if (argv[0] === "claude" && argv[1] === "agents") {
      return { exitCode: 0, stdout: "[]", stderr: "" }; // nothing currently running -> forces a restore attempt
    }
    if (argv[0] === "systemd-run") {
      const shortId = `short-${n++}`;
      return { exitCode: 0, stdout: `backgrounded · ${shortId} (idle — send a prompt to start)\n`, stderr: "" };
    }
    throw new Error(`unexpected argv: ${JSON.stringify(argv)}`);
  };
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

    const deps: DaemonDeps = {
      runCommand: fakeRunCommand(),
      claimsPath: join(storeDir, "claims.json"),
      sessionSlotsPath: join(storeDir, "session-slots.json"),
      now: () => Date.now(),
      generateAttemptId: () => "restore-attempt",
    };

    const before = await snapshot(claimedDir);
    const result = await runReconcileCycle(initialDaemonState(), deps);
    expect(result.restored).toHaveLength(1); // confirms a restore genuinely happened, not a vacuous pass
    const after = await snapshot(claimedDir);

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
    const before = await snapshot(claimedDir);

    const deps: DaemonDeps = {
      runCommand: fakeRunCommand(),
      claimsPath: join(storeDir, "claims.json"),
      sessionSlotsPath: join(storeDir, "session-slots.json"),
      now: () => Date.now(),
      generateAttemptId: () => "restore-attempt",
    };

    // Any write attempt into claimedDir from here on would throw EACCES and fail this test outright.
    const result = await runReconcileCycle(initialDaemonState(), deps);
    expect(result.restored).toHaveLength(1);

    // Snapshot BEFORE restoring permissions — chmod itself changes the
    // directory's own ctime, and that must not be mistaken for a write
    // bakr made. Permissions are restored afterward, purely for the
    // recursive rm in afterEach to succeed.
    const after = await snapshot(claimedDir);
    await chmod(claimedDir, 0o755);

    expectUnchanged(before, after);
  });
});
