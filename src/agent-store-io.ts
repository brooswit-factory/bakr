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
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type AgentStoreState, emptyAgentStore, parseAgentStoreState, serializeAgentStoreState } from "./agent-model";
import { acquireStoreLockForFixture, withStoreLock, type MutateOutcome } from "./store-lock";

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

// --- Cross-process lock (B12, R-F) -----------------------------------
//
// Extracted to store-lock.ts (BAKR-24) so the claim store can share the
// identical kernel-flock discipline instead of duplicating it — see that
// module's own comment for the two BAKR-20 concurrency findings that drove
// this design (mutual exclusion was not actually guaranteed under the old
// O_EXCL-plus-parsed-content scheme, and an unreadable lock file could wedge
// every acquire forever) and for why `staleLockMs`/steal-by-pid is gone from
// the API. Everything below is a thin, BEHAVIOUR-PRESERVING wrapper: same
// lock file path (`${path}.lock`), same kernel flock, same retry loop, same
// diagnostic content, same never-unlink-on-release rule.

/** See store-lock.ts's own doc — identical discipline, specialized to `AgentStoreState`. */
export async function acquireAgentStoreLockForFixture(agentsPath: string, acquireTimeoutMs?: number): Promise<{ readonly release: () => Promise<void> }> {
  return acquireStoreLockForFixture(agentsPath, acquireTimeoutMs);
}

export type { MutateOutcome };

/** See store-lock.ts's `withStoreLock` doc — identical discipline, specialized to `AgentStoreState`. THE ONE HELPER every mutation of `agents.json` goes through (the daemon's and the harness's alike). */
export async function withAgentStoreLock<T>(
  path: string,
  mutate: (current: AgentStoreState) => { readonly state: AgentStoreState; readonly result: T },
  opts?: { readonly acquireTimeoutMs?: number }
): Promise<MutateOutcome<T>> {
  return withStoreLock(path, emptyAgentStore(), load, save, mutate, opts);
}
