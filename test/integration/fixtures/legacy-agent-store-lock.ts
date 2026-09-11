// BAKR-20: a frozen, standalone copy of the PRE-FIX `acquireLock` /
// `releaseLock` / `withAgentStoreLock` from agent-store-io.ts (the O_EXCL +
// parsed-content + unconditional-`rm` scheme Findings 1 and 2 were filed
// against) — kept ONLY so the new contention regression test can prove
// itself against a red baseline ("patch the old logic back in a scratch
// copy, watch the new test go red, restore, watch it go green" — ticket
// §3.3). This file is NEVER imported by production code, only by
// test/integration/agent-store-lock-contention.test.ts's own
// "shown failing against the old code" case and its worker fixture.
//
// Deliberately byte-for-byte the same algorithm the ticket describes and
// this repo's own git history shows prior to this change — not a
// caricature tuned to fail more easily than the real thing did.
import { open, readFile, rm } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { type AgentStoreState, emptyAgentStore } from "../../../src/agent-model";
import { load, save, type MutateOutcome } from "../../../src/agent-store-io";
import { isPidAlive } from "../../../src/spawn/liveness";

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

function isEexist(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "EEXIST";
}

async function readLockInfoLegacy(lockPath: string): Promise<LockInfo | undefined> {
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

async function acquireLockLegacy(lockPath: string, staleLockMs: number, acquireTimeoutMs: number): Promise<void> {
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

      const info = await readLockInfoLegacy(lockPath);
      const holderConfirmedDead = info !== undefined && !isPidAlive(info.pid);
      const holderStale = info !== undefined && Date.now() - info.acquiredAt > staleLockMs;
      if (holderConfirmedDead || holderStale) {
        // THE BUG (Finding 1): unconditionally removes whatever is at this
        // PATH right now — never verified to still be the SAME lock
        // instance whose info was just read above.
        await rm(lockPath, { force: true }).catch(() => {});
        continue;
      }

      if (Date.now() > deadline) {
        const holder = info !== undefined ? `pid ${info.pid} since ${new Date(info.acquiredAt).toISOString()}` : "an unreadable lock file";
        throw new Error(`timed out after ${acquireTimeoutMs}ms waiting for the agent store lock at "${lockPath}" (held by ${holder})`);
      }
      await sleep(RETRY_DELAY_MS);
    }
  }
}

async function releaseLockLegacy(lockPath: string): Promise<void> {
  await rm(lockPath, { force: true });
}

/** The pre-fix `withAgentStoreLock`, unchanged in shape — TOCTOU-vulnerable (Finding 1) and wedges forever on an unreadable lock file (Finding 2). */
export async function withAgentStoreLockLegacy<T>(
  path: string,
  mutate: (current: AgentStoreState) => { readonly state: AgentStoreState; readonly result: T },
  opts?: { readonly staleLockMs?: number; readonly acquireTimeoutMs?: number }
): Promise<MutateOutcome<T>> {
  const lockPath = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true });
  await acquireLockLegacy(lockPath, opts?.staleLockMs ?? DEFAULT_STALE_LOCK_MS, opts?.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS);
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
    await releaseLockLegacy(lockPath);
  }
}
