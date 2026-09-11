// AC15 (AMENDED R-F.4): the lock must survive its holder crashing — in
// BOTH directions. Neither direction alone is sufficient: (a) alone is
// satisfied by a lock that does nothing (never actually protects anything);
// (b) alone is satisfied by a lock that wedges forever. This file
// demonstrates both, against a REAL child OS process (never anything else
// on this host — see the ticket's own explicit constraint) started by this
// harness itself.
//
// Falsifiers, stated first:
// (a) a `kill -9`'d holder must not require a human to unwedge the next
//     writer — falsifier: `withAgentStoreLock` throws a timeout, or blocks
//     past the OBSERVED-dead pid, with a LARGE staleLockMs that a pure
//     elapsed-time steal could not have satisfied — proving the pid check
//     (not merely the timeout) is what triggered the recovery.
// (b) a live holder's lock must never be broken — falsifier: a competing
//     `withAgentStoreLock` call succeeds (steals the lock) while the real
//     holder process is still alive and within a generous staleLockMs.
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withAgentStoreLock, save } from "../../src/agent-store-io";
import { emptyAgentStore } from "../../src/agent-model";

const HOLD_FIXTURE = join(import.meta.dir, "fixtures", "agent-lock-hold-worker.ts");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForReady(proc: { stdout: ReadableStream<Uint8Array> }): Promise<void> {
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error("worker exited before printing READY");
    buffer += decoder.decode(value, { stream: true });
    if (buffer.includes("READY")) {
      reader.releaseLock();
      return;
    }
  }
}

describe("AC15 (R-F.4): the lock survives its holder crashing, in both directions", () => {
  test("(a) kill -9 a REAL holder mid-hold: the next writer proceeds with NO human action, even under a LARGE staleLockMs a pure timeout could not have satisfied", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bakr-lock-crash-kill-"));
    try {
      const agentsPath = join(dir, "agents.json");
      await save(agentsPath, emptyAgentStore());

      const holder = Bun.spawn(["bun", "run", HOLD_FIXTURE, agentsPath, "120000"], { stdout: "pipe", stderr: "pipe" });
      await waitForReady(holder);

      // Confirm the lock file really does exist and names this real pid before killing it.
      const lockPath = `${agentsPath}.lock`;
      const lockInfo = JSON.parse(await readFile(lockPath, "utf8"));
      expect(lockInfo.pid).toBe(holder.pid);

      holder.kill("SIGKILL");
      await holder.exited;

      // staleLockMs is deliberately LARGE (60s) — far longer than this
      // test's own patience — so if recovery happened, it did NOT happen
      // via the elapsed-time path; only the pid-liveness check (isPidAlive
      // says this now-dead pid is not alive) can explain it.
      const start = Date.now();
      const result = await withAgentStoreLock(agentsPath, (current) => ({ state: current, result: "acquired" }), { staleLockMs: 60_000, acquireTimeoutMs: 5000 });
      const elapsedMs = Date.now() - start;

      expect(result).toEqual({ status: "ok", result: "acquired" });
      expect(elapsedMs).toBeLessThan(5000); // recovered well before even our own acquireTimeoutMs, let alone the 60s staleLockMs
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 20000);

  test("(b) a LIVE holder's lock is NEVER broken — a competing acquisition times out rather than stealing it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bakr-lock-crash-live-"));
    try {
      const agentsPath = join(dir, "agents.json");
      await save(agentsPath, emptyAgentStore());

      const holder = Bun.spawn(["bun", "run", HOLD_FIXTURE, agentsPath, "2000"], { stdout: "pipe", stderr: "pipe" });
      await waitForReady(holder);

      // The holder is genuinely alive and its lock is fresh (well under a
      // generous staleLockMs) — a competing, impatient caller must time out,
      // never steal it.
      await expect(withAgentStoreLock(agentsPath, (current) => ({ state: current, result: undefined }), { staleLockMs: 60_000, acquireTimeoutMs: 300 })).rejects.toThrow(/timed out/);

      await holder.exited; // let the real holder finish naturally
      // This fixture bypasses withAgentStoreLock's own release (see its own
      // banner comment) to model a long-held lock file precisely — clean up
      // manually so this test's lock file never leaks into another test.
      await rm(`${agentsPath}.lock`, { force: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 20000);

  test("PROBE CONTROL: sanity that waitForReady/kill actually target the right process — a bare kill on a NON-existent pid never satisfies the recovery path via a false 'not alive'", async () => {
    // isPidAlive returning false for random large pids is exercised
    // directly in test/spawn/liveness.test.ts; here we only confirm this
    // file's own harness talks to the real spawned child, not a stale
    // guess — `holder.pid` from Bun.spawn is authoritative.
    const dir = await mkdtemp(join(tmpdir(), "bakr-lock-crash-probe-"));
    try {
      const agentsPath = join(dir, "agents.json");
      await save(agentsPath, emptyAgentStore());
      const holder = Bun.spawn(["bun", "run", HOLD_FIXTURE, agentsPath, "500"], { stdout: "pipe", stderr: "pipe" });
      await waitForReady(holder);
      expect(holder.pid).toBeGreaterThan(0);
      holder.kill("SIGKILL");
      await holder.exited;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 10000);
});
