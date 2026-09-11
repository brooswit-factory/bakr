// Durable, atomic persistence for the agent store (BAKR-19/BAKR-16 R-F),
// PLUS the cross-process write discipline B12 asks for: a lock around every
// load-modify-save, re-reading fresh from disk INSIDE the lock so a
// concurrent writer's update is never silently clobbered (a lost update —
// the specific failure atomic temp+fsync+rename does NOT protect against;
// see the module comment on `withAgentStoreLock` below for why).
//
// `load`/`save` themselves mirror claim-store-io.ts / session-slots-store.ts
// exactly: the same three typed outcomes (`missing` / `malformed` /
// `loaded`), the same temp-file + fsync + rename + fsync-the-directory
// atomic write. The agent store is in the identical unreconstructable-from-
// nothing position those two files are in — nothing in bakr may resolve an
// agent from a directory or a listing alone, so there is no live oracle to
// rebuild it from — so `load` reports `malformed` as its own outcome and
// leaves the decision to the caller (see daemon.ts), exactly as those two
// modules already do.

import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type AgentStoreState, emptyAgentStore, parseAgentStoreState, serializeAgentStoreState } from "./agent-model";
import { isPidAlive } from "./spawn/liveness";

export type LoadOutcome =
  | { readonly status: "missing" }
  | { readonly status: "malformed"; readonly error: string }
  | { readonly status: "loaded"; readonly state: AgentStoreState };

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "ENOENT";
}

function isEexist(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "EEXIST";
}

/** See claim-store-io.ts's `load` doc comment — identical discipline, applied to this file instead. */
export async function load(path: string): Promise<LoadOutcome> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (err) {
    if (isEnoent(err)) {
      return { status: "missing" };
    }
    return { status: "malformed", error: err instanceof Error ? err.message : String(err) };
  }

  const result = parseAgentStoreState(source);
  if (!result.ok) {
    return { status: "malformed", error: result.error };
  }
  return { status: "loaded", state: result.state };
}

/** See claim-store-io.ts's `save` doc comment — identical atomic-write dance, applied to this file instead. Callers doing a read-modify-write MUST go through `withAgentStoreLock` below, never call this directly against a state read outside a lock (that is exactly the lost-update hazard B12/R-F exists to close). */
export async function save(path: string, state: AgentStoreState): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });

  const tmpPath = join(dir, `.${randomUUID()}.tmp`);
  const fileHandle = await open(tmpPath, "w");
  try {
    await fileHandle.writeFile(serializeAgentStoreState(state), "utf8");
    await fileHandle.sync();
  } finally {
    await fileHandle.close();
  }

  await rename(tmpPath, path);

  const dirHandle = await open(dir, "r");
  try {
    await dirHandle.sync();
  } finally {
    await dirHandle.close();
  }
}

// --- Cross-process lock (B12, R-F) ---------------------------------------

const DEFAULT_STALE_LOCK_MS = 30_000;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 20;

interface LockInfo {
  readonly pid: number;
  readonly acquiredAt: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readLockInfo(lockPath: string): Promise<LockInfo | undefined> {
  try {
    const raw = await readFile(lockPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>)["pid"] === "number" &&
      typeof (parsed as Record<string, unknown>)["acquiredAt"] === "number"
    ) {
      return parsed as LockInfo;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * `O_EXCL` lock file beside the store — `open(path, "wx")` fails with
 * `EEXIST` when another holder already has it (R-F). Records a pid and a
 * timestamp in the lock file itself (diagnostic — "record something
 * diagnostic in the lock file ... so a human can tell what held it") so a
 * human inspecting a wedged lock can tell what (or who) is holding it and
 * since when.
 *
 * AMENDED (R-F.4): the lock must survive its holder crashing, in BOTH
 * directions — a naive elapsed-time-only steal satisfies neither on its
 * own (it either breaks a live-but-slow holder once its lock looks old
 * enough, or leaves a `kill -9`'d holder wedging every future writer until
 * that same timeout finally elapses). This tree already ships and tests
 * `isPidAlive` (`src/spawn/liveness.ts`) for exactly this kind of positive
 * liveness check, never an inference from absence — reused here rather
 * than reinvented. A lock is breakable when EITHER:
 * - the recorded pid is confirmed NOT alive (`isPidAlive` false) — a
 *   POSITIVE fact (ESRCH), not a guess, so this fires immediately,
 *   regardless of `staleLockMs`, the instant a crashed holder is detected; or
 * - the lock is older than `staleLockMs` — the backstop for the one case
 *   pid-liveness alone cannot cover: the OS reusing the dead holder's pid
 *   for an unrelated live process, which would otherwise make a crashed
 *   holder's lock look falsely alive forever.
 * A holder that is both alive AND within `staleLockMs` is NEVER broken —
 * the other, equally load-bearing half of R-F.4. `acquireTimeoutMs` is a
 * second, independent bound: the total time this call waits for such a
 * healthy holder to release on its own before giving up and throwing, so a
 * genuinely slow-but-legitimate holder does not wedge a caller forever.
 */
async function acquireLock(lockPath: string, staleLockMs: number, acquireTimeoutMs: number): Promise<void> {
  const deadline = Date.now() + acquireTimeoutMs;
  for (;;) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: Date.now() } satisfies LockInfo), "utf8");
      } finally {
        await handle.close();
      }
      return;
    } catch (err) {
      if (!isEexist(err)) throw err;

      const info = await readLockInfo(lockPath);
      const holderConfirmedDead = info !== undefined && !isPidAlive(info.pid);
      const holderStale = info !== undefined && Date.now() - info.acquiredAt > staleLockMs;
      if (holderConfirmedDead || holderStale) {
        await rm(lockPath, { force: true }).catch(() => {});
        continue; // retry immediately after stealing
      }

      if (Date.now() > deadline) {
        const holder = info !== undefined ? `pid ${info.pid} since ${new Date(info.acquiredAt).toISOString()}` : "an unreadable lock file";
        throw new Error(`timed out after ${acquireTimeoutMs}ms waiting for the agent store lock at "${lockPath}" (held by ${holder})`);
      }
      await sleep(RETRY_DELAY_MS);
    }
  }
}

async function releaseLock(lockPath: string): Promise<void> {
  await rm(lockPath, { force: true });
}

export type MutateOutcome<T> = { readonly status: "ok"; readonly result: T } | { readonly status: "malformed"; readonly error: string };

/**
 * THE ONE HELPER every mutation of `agents.json` goes through — the
 * daemon's and the harness's alike (R-F). Takes the exclusive lock,
 * RE-READS the store fresh from disk INSIDE the lock, hands that fresh
 * state to `mutate`, saves its result atomically, then releases.
 *
 * Why re-reading inside the lock is the actual fix, not merely a nicety:
 * atomic temp+fsync+rename (see `save` above) prevents a reader from ever
 * observing a torn/partial file, but it does nothing to stop a LOST UPDATE
 * — a second writer's change landing between a first writer's own load and
 * its later save is silently overwritten by that first writer's save,
 * atomically, which is worse than a torn file because nothing about the
 * resulting file looks wrong. A lock around `save` ALONE would not close
 * this gap either — the daemon's old pattern of loading once at the top of
 * a cycle and threading that state through several later saves is exactly
 * the shape that loses an operator's concurrent write. Reading fresh
 * *after* acquiring the lock, and mutating THAT snapshot, is what makes a
 * lost update impossible: no other writer can be mid-mutation while this
 * one holds the lock, and this one never mutates a snapshot older than the
 * moment it acquired the lock.
 *
 * A malformed store is reported as its own outcome, exactly like `load`,
 * and NOTHING is written in that case — Constraint 3's discipline (never
 * overwrite a malformed store) applies here identically; the caller (see
 * daemon.ts) is responsible for treating a `malformed` result as a
 * process-lifetime degrade, the same as a plain `load` would ask it to.
 *
 * The caller must NOT hold this lock across `launch()` — call it once to
 * record intent, let `launch()` run unlocked, then call it again to record
 * the outcome (see daemon.ts). `launch()` spawns a process with its own
 * multi-second timeout; holding this lock across it would block every
 * other writer (including an operator's own action) for that whole window.
 */
export async function withAgentStoreLock<T>(
  path: string,
  mutate: (current: AgentStoreState) => { readonly state: AgentStoreState; readonly result: T },
  opts?: { readonly staleLockMs?: number; readonly acquireTimeoutMs?: number }
): Promise<MutateOutcome<T>> {
  const lockPath = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true });
  await acquireLock(lockPath, opts?.staleLockMs ?? DEFAULT_STALE_LOCK_MS, opts?.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS);
  try {
    const loaded = await load(path);
    if (loaded.status === "malformed") {
      return { status: "malformed", error: loaded.error };
    }
    const current = loaded.status === "loaded" ? loaded.state : emptyAgentStore();
    const { state, result } = mutate(current);
    await save(path, state);
    return { status: "ok", result };
  } finally {
    await releaseLock(lockPath);
  }
}
