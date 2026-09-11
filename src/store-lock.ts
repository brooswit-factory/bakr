// A generic, store-shaped kernel-flock lock (BAKR-24, extracted from
// agent-store-io.ts's own BAKR-20 implementation — see that file's module
// comment for the two concurrency findings that drove the kernel-flock
// design and why `staleLockMs`/steal-by-pid was abandoned). Extracted here
// because this ticket adds a SECOND store that needs the identical
// read-fresh-inside-the-lock discipline B12 asks for — the claim store,
// which until now had no locked writer (only the provisional
// `demo-claim.ts` harness wrote it, unlocked, single-process). Rather than
// duplicate ~150 lines of FFI/lock plumbing a second time, this module
// generalizes it over any store shaped like `{ missing | malformed |
// loaded }` load / plain save — agent-store-io.ts and claim-store-io.ts are
// now both thin callers of `withStoreLock` below, with IDENTICAL locking
// behaviour to before (same kernel flock, same retry loop, same diagnostic
// file, same never-unlink-on-release rule) — this is a pure extraction, not
// a behaviour change, and every existing agent-store lock test keeps
// exercising the exact same code path through its unchanged public API.

import { dlopen, FFIType } from "bun:ffi";
import { type FileHandle, mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export type StoreLoadOutcome<S> = { readonly status: "missing" } | { readonly status: "malformed"; readonly error: string } | { readonly status: "loaded"; readonly state: S };

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "ENOENT";
}

function isEexist(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "EEXIST";
}

// --- Cross-process lock (B12, R-F, ported unchanged from agent-store-io.ts's BAKR-20 implementation) ---

const LOCK_EX = 2;
const LOCK_NB = 4;

// Verified empirically against THIS runtime (bun 1.3.14, Linux) before
// committing to this mechanism — `node:fs` does not expose `flock`; `bun:ffi`
// against libc does. Only the Linux path has been exercised; the darwin path
// is included for dev-machine convenience and relies on `flock(2)`'s
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

/** Diagnostic only — never consulted to decide whether to acquire or steal. Lets a human `cat` a wedged lock file and see who (as of the last successful acquire) is holding it. Tolerates any unreadable content. */
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
 * content and without O_EXCL (many processes are meant to share this path
 * concurrently — the kernel lock, not file creation, provides exclusivity).
 * Two processes racing to create it for the first time both converge on the
 * same inode: whichever loses the `wx` race simply reopens the file the
 * winner just created.
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

interface StoreLock {
  readonly handle: FileHandle;
}

/**
 * Non-blocking acquisition in a retry loop, so `acquireTimeoutMs` and its
 * timeout error behave predictably rather than blocking on the kernel
 * indefinitely. Once acquired, overwrites the file's content with fresh
 * diagnostic {pid, acquiredAt} JSON — a positioned write, not an append, so
 * the file never grows across repeated acquire/release cycles over a
 * long-running daemon's lifetime.
 */
async function acquireLock(lockPath: string, acquireTimeoutMs: number): Promise<StoreLock> {
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
      throw new Error(`timed out after ${acquireTimeoutMs}ms waiting for the store lock at "${lockPath}" (held by ${holder})`);
    }
    await sleep(RETRY_DELAY_MS);
  }
}

/** Releases by CLOSING the fd — never unlinking the path (unlinking would let a future opener lock a different inode at the same path while this fd's flock is still notionally "held" by the closed-but-undeleted description). The kernel drops the flock the instant this fd (the last one referencing this open file description) closes. */
async function releaseLock(lock: StoreLock): Promise<void> {
  await lock.handle.close();
}

/**
 * Exposed ONLY for test fixtures that must hold the real lock across an
 * async boundary (a `sleep`, most often) that `withStoreLock`'s synchronous
 * `mutate` callback cannot express — production code must always go through
 * `withStoreLock`/`withAgentStoreLock`/`withClaimStoreLock`. A fixture using
 * this holds the IDENTICAL kernel lock a real caller would.
 */
export async function acquireStoreLockForFixture(storePath: string, acquireTimeoutMs = DEFAULT_ACQUIRE_TIMEOUT_MS): Promise<{ readonly release: () => Promise<void> }> {
  const lockPath = `${storePath}.lock`;
  await mkdir(dirname(storePath), { recursive: true });
  const lock = await acquireLock(lockPath, acquireTimeoutMs);
  return { release: () => releaseLock(lock) };
}

export type MutateOutcome<T> = { readonly status: "ok"; readonly result: T } | { readonly status: "malformed"; readonly error: string };

/**
 * THE ONE HELPER every mutation of a lock-disciplined store goes through
 * (R-F/B12). Takes the exclusive lock, RE-READS the store fresh from disk
 * INSIDE the lock via the caller's own `load`, hands that fresh state to
 * `mutate`, saves its result atomically via the caller's own `save`, then
 * releases. See agent-store-io.ts's original module comment (now here in
 * spirit) for why re-reading inside the lock — not merely locking around
 * `save` — is what closes the lost-update hazard: a second writer's change
 * landing between a first writer's own load and its later save would
 * otherwise be silently, atomically clobbered.
 *
 * A malformed store is reported as its own outcome and NOTHING is written —
 * the caller is responsible for treating `malformed` as a process-lifetime
 * degrade, exactly as a plain `load` would ask it to.
 *
 * The caller must NOT hold this lock across a spawn or any other slow I/O
 * outside the store itself (B12) — call it once to decide/record intent,
 * let the slow thing run unlocked, call it again to record the outcome.
 *
 * Re-entrancy: taking this lock twice from the SAME process on the SAME
 * path deadlocks against itself (two `open()`s on the same path create
 * distinct file descriptions, which conflict with each other under `flock`
 * exactly like two different processes would). Never nest a locked call
 * inside another's `mutate`.
 */
export async function withStoreLock<S, T>(
  path: string,
  emptyState: S,
  load: (path: string) => Promise<StoreLoadOutcome<S>>,
  save: (path: string, state: S) => Promise<void>,
  mutate: (current: S) => { readonly state: S; readonly result: T },
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
    const current = loaded.status === "loaded" ? loaded.state : emptyState;
    const { state, result } = mutate(current);
    // A no-op mutation (mutate returns the SAME state object it was handed,
    // by reference) is genuinely skipped — a reference check, not a
    // deep-equality one, by design: costs nothing extra and every existing
    // no-op caller already returns `current` unchanged.
    if (state !== current) {
      await save(path, state);
    }
    return { status: "ok", result };
  } finally {
    await releaseLock(lock);
  }
}
