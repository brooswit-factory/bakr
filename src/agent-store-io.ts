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

import { dlopen, FFIType } from "bun:ffi";
import { randomUUID } from "node:crypto";
import { type FileHandle, mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type AgentStoreState, emptyAgentStore, parseAgentStoreState, serializeAgentStoreState } from "./agent-model";

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

// --- Cross-process lock (B12, R-F, AMENDED BAKR-20) -----------------------
//
// BAKR-20 replaced the original O_EXCL-plus-parsed-content lock with a
// kernel lock on an open file description (`flock(2)`, `LOCK_EX|LOCK_NB`).
// Two findings drove the change, both against the OLD scheme:
//
// 1. Mutual exclusion was NOT actually guaranteed. The old `acquireLock`
//    read a holder's {pid, acquiredAt}, judged it dead/stale, then `rm`'d
//    the lock PATH unconditionally — three steps not tied to one lock
//    instance. If the judged-dead holder released and a NEW holder
//    acquired in the gap between that read and the `rm`, the waiter
//    deleted the live holder's lock and both proceeded: a lost update,
//    reported `ok` by both writers. Measured 3/20 trials with a seeded
//    dead-holder lock file, 6/6 on a positive control with no lock at all.
// 2. An unreadable lock file (empty, or half-written by a crash between
//    `open(path, "wx")` and the pid write landing) could never be judged
//    dead or stale — `readLockInfo` returns `undefined` for it, and both
//    break conditions require `info !== undefined`. That wedged the
//    daemon's restore cycle permanently: every acquire attempt threw a
//    timeout, forever, until a human deleted the file by hand.
//
// A kernel lock on an fd kills both at once, structurally rather than by
// being more careful with the same shape:
//
// - There is no steal path, so there is nothing for a TOCTOU race to land
//   in — the kernel grants `LOCK_EX` to at most one open file description
//   at a time, full stop. Finding 1 cannot occur.
// - The lock lives on the file description, never on parsed content, so
//   Finding 2's question ("is this content readable enough to judge
//   dead/stale?") does not arise — an empty or half-written lock file
//   locks and unlocks exactly like a well-formed one. Demonstrated in
//   agent-store-io.test.ts under "Finding 2 fixtures are now moot".
// - A crashed holder's lock is released by the KERNEL the instant the
//   process's last fd closes (on a clean exit, an uncaught throw, or a
//   `kill -9` alike — see agent-store-lock-crash-recovery.test.ts) — never
//   inferred from a pid or a timestamp.
//
// `staleLockMs` is gone from the public API. It existed to answer "is this
// holder dead or just slow?" from OUTSIDE the OS — a question a kernel
// lock answers FOR you: a genuinely dead holder's lock is already gone by
// the time anyone would ask, and a genuinely alive holder's lock (however
// slow) is correctly still held. There is no remaining case for a
// time-based guess to resolve, so the knob is removed rather than kept
// dead in the API. `acquireTimeoutMs` is unchanged — it still bounds how
// long a caller waits for a genuinely busy, live holder before giving up.
//
// Two invariants the ticket calls out explicitly, both load-bearing:
// - NEVER unlink the lock file on release. Unlinking a flocked file lets a
//   later opener lock a DIFFERENT inode at the same path while an older
//   holder still holds the deleted one under the old inode — silently
//   defeating mutual exclusion. The file is created once (if absent) and
//   left in place forever after; only the fd's flock is released, by
//   closing it.
// - Non-blocking acquisition (`LOCK_EX|LOCK_NB`) in a retry loop, so the
//   pre-existing `acquireTimeoutMs` behaviour and its timeout error are
//   preserved rather than blocking on the kernel indefinitely.

const LOCK_EX = 2;
const LOCK_NB = 4;

// Verified empirically against THIS runtime (bun 1.3.14, Linux) before
// committing to this mechanism, per the ticket's own instruction not to
// assume `node:fs` exposes `flock` (it does not) — `bun:ffi` against libc
// does. Only the Linux path has been exercised; the darwin path is
// included for dev-machine convenience and relies on `flock(2)`'s
// LOCK_EX/LOCK_NB values being the same 4.2BSD-derived constants on both
// platforms, unverified on an actual Mac.
const LIBC_PATH = process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6";

const libc = dlopen(LIBC_PATH, {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
});

function tryLockExclusive(fd: number): boolean {
  return libc.symbols.flock(fd, LOCK_EX | LOCK_NB) === 0;
}

const DEFAULT_ACQUIRE_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 20;

interface LockInfo {
  readonly pid: number;
  readonly acquiredAt: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Diagnostic only — never consulted to decide whether to acquire or steal (see module comment). Lets a human `cat` a wedged lock file and see who (as of the last successful acquire) is holding it. Tolerates any unreadable content, exactly like before. */
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
 * Opens the lock file, creating it if absent, WITHOUT truncating existing
 * content and without O_EXCL (unlike the old scheme, many processes are
 * meant to share this path concurrently — the kernel lock, not file
 * creation, is what provides exclusivity). Two processes racing to create
 * it for the first time both converge on the same inode: whichever loses
 * the `wx` race simply reopens the file the winner just created.
 */
async function openLockFile(lockPath: string): Promise<FileHandle> {
  for (;;) {
    try {
      return await open(lockPath, "r+");
    } catch (err) {
      if (!isEnoent(err)) throw err;
    }
    try {
      return await open(lockPath, "wx");
    } catch (err) {
      if (!isEexist(err)) throw err;
      // Another process created it between our "r+" and this "wx" — loop and reopen with "r+".
    }
  }
}

interface AgentStoreLock {
  readonly handle: FileHandle;
}

/**
 * Non-blocking acquisition in a retry loop (ticket's own steer), so
 * `acquireTimeoutMs` and its timeout error behave exactly as before. Once
 * acquired, overwrites the file's content with fresh diagnostic
 * {pid, acquiredAt} JSON — a positioned write, not an append, so the file
 * never grows across repeated acquire/release cycles over a long-running
 * daemon's lifetime.
 */
async function acquireLock(lockPath: string, acquireTimeoutMs: number): Promise<AgentStoreLock> {
  const handle = await openLockFile(lockPath);
  const deadline = Date.now() + acquireTimeoutMs;
  for (;;) {
    if (tryLockExclusive(handle.fd)) {
      try {
        const diagnostic = Buffer.from(JSON.stringify({ pid: process.pid, acquiredAt: Date.now() } satisfies LockInfo), "utf8");
        await handle.truncate(0);
        await handle.write(diagnostic, 0, diagnostic.byteLength, 0);
      } catch {
        // Diagnostic content only — never load-bearing for correctness. A failure here must not fail the acquire itself.
      }
      return { handle };
    }

    if (Date.now() > deadline) {
      const info = await readLockInfo(lockPath);
      const holder = info !== undefined ? `pid ${info.pid} as of its last recorded acquire at ${new Date(info.acquiredAt).toISOString()} (diagnostic only, may be stale)` : "another process (its diagnostic info was unreadable)";
      await handle.close();
      throw new Error(`timed out after ${acquireTimeoutMs}ms waiting for the agent store lock at "${lockPath}" (held by ${holder})`);
    }
    await sleep(RETRY_DELAY_MS);
  }
}

/** Releases by CLOSING the fd — never unlinking the path (see module comment: unlinking would let a future opener lock a different inode at the same path while this fd's flock is still notionally "held" by the closed-but-undeleted description). The kernel drops the flock the instant this fd (the last one referencing this open file description) closes. */
async function releaseLock(lock: AgentStoreLock): Promise<void> {
  await lock.handle.close();
}

/**
 * Exposed ONLY for test fixtures that must hold the real lock across an
 * async boundary (a `sleep`, most often) that `withAgentStoreLock`'s
 * synchronous `mutate` callback cannot express — production code must
 * always go through `withAgentStoreLock`. A fixture using this holds the
 * IDENTICAL kernel lock a real caller would, not a hand-rolled stand-in —
 * necessary now that "the lock" is an flock on an fd rather than a file a
 * fixture could plausibly reimplement by hand in a few lines.
 */
export async function acquireAgentStoreLockForFixture(agentsPath: string, acquireTimeoutMs = DEFAULT_ACQUIRE_TIMEOUT_MS): Promise<{ readonly release: () => Promise<void> }> {
  const lockPath = `${agentsPath}.lock`;
  await mkdir(dirname(agentsPath), { recursive: true });
  const lock = await acquireLock(lockPath, acquireTimeoutMs);
  return { release: () => releaseLock(lock) };
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
 *
 * Re-entrancy: taking this lock twice from the SAME process (two `open()`s
 * on the same path create distinct file descriptions, which conflict with
 * each other under `flock` exactly like two different processes would —
 * verified empirically) deadlocks against itself. Nothing in this tree
 * nests one call inside another's `mutate` — `promoteWedgedLaunches`,
 * `resolvePendingLaunches`, `decideAndBeginForAgent` and
 * `recordLaunchOutcome` (daemon.ts) each take and release independently.
 */
export async function withAgentStoreLock<T>(
  path: string,
  mutate: (current: AgentStoreState) => { readonly state: AgentStoreState; readonly result: T },
  opts?: { readonly acquireTimeoutMs?: number }
): Promise<MutateOutcome<T>> {
  const lockPath = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true });
  const lock = await acquireLock(lockPath, opts?.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS);
  try {
    const loaded = await load(path);
    if (loaded.status === "malformed") {
      return { status: "malformed", error: loaded.error };
    }
    const current = loaded.status === "loaded" ? loaded.state : emptyAgentStore();
    const { state, result } = mutate(current);
    // BAKR-20 Finding 3: a no-op mutation (mutate returns the SAME state
    // object it was handed, by reference) is genuinely skipped — this is
    // what makes daemon.ts's "a no-op save is skipped" comment true, for
    // every caller of this helper, not merely the one it was written
    // about. A mutate that builds a new object with equal contents (rather
    // than returning `current` itself) still saves — this is a reference
    // check, not a deep-equality one, by design: it costs nothing extra
    // and every existing no-op caller already returns `current` unchanged.
    if (state !== current) {
      await save(path, state);
    }
    return { status: "ok", result };
  } finally {
    await releaseLock(lock);
  }
}
