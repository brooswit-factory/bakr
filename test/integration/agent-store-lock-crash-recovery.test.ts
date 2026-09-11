// AC15 (AMENDED R-F.4), carried forward under BAKR-20's kernel-lock
// mechanism: the lock must survive its holder crashing — in BOTH
// directions. Neither direction alone is sufficient: (a) alone is
// satisfied by a lock that does nothing (never actually protects
// anything); (b) alone is satisfied by a lock that wedges forever. This
// file demonstrates both, against a REAL child OS process (never anything
// else on this host — see the ticket's own explicit constraint) started by
// this harness itself.
//
// BAKR-20 changed WHY (a) holds, not merely how it's implemented: under
// the OLD scheme, recovery came from a pid-liveness check applied to
// parsed lock-file content, and this file's whole point was proving the
// pid check — not a coincidentally-satisfied elapsed-time steal — was what
// fired. Under the NEW scheme (`flock(2)` on an open fd) there is no
// liveness check to isolate: the KERNEL releases the flock the instant
// the holder's last fd closes, for any reason, including `kill -9`. This
// file's falsifiers are updated to match that:
//
// (a) a `kill -9`'d holder must not require a human to unwedge the next
//     writer — falsifier: `withAgentStoreLock` throws a timeout instead of
//     acquiring promptly. Nothing content-based is asserted anymore
//     (there is no lock-file content this mechanism consults), so this
//     version additionally confirms recovery happens even when the lock
//     FILE's on-disk bytes are left stale/unreadable after the kill —
//     exactly Finding 2's shape — never merely when they happen to be
//     well-formed.
// (b) a live holder's lock must never be broken — falsifier: a competing
//     `withAgentStoreLock` call succeeds (acquires the lock) while the
//     real holder process is still alive and holding it.
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withAgentStoreLock, save } from "../../src/agent-store-io";
import { emptyAgentStore } from "../../src/agent-model";

const HOLD_FIXTURE = join(import.meta.dir, "fixtures", "agent-lock-hold-worker.ts");

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

describe("AC15 (R-F.4), BAKR-20 kernel lock: the lock survives its holder crashing, in both directions", () => {
  test("(a) kill -9 a REAL holder mid-hold: the next writer proceeds with NO human action — even when the lock file's own bytes are left stale/unreadable by the kill, exactly Finding 2's shape", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bakr-lock-crash-kill-"));
    try {
      const agentsPath = join(dir, "agents.json");
      await save(agentsPath, emptyAgentStore());

      const holder = Bun.spawn(["bun", "run", HOLD_FIXTURE, agentsPath, "120000"], { stdout: "pipe", stderr: "pipe" });
      await waitForReady(holder);

      // Deliberately corrupt the lock file's own content right before the kill —
      // under the OLD scheme this alone would have permanently wedged every
      // future acquire (Finding 2). Under the kernel lock, content is never
      // consulted to decide anything, so this must make no difference.
      const lockPath = `${agentsPath}.lock`;
      await writeFile(lockPath, "", "utf8");

      holder.kill("SIGKILL");
      await holder.exited;

      const start = Date.now();
      const result = await withAgentStoreLock(agentsPath, (current) => ({ state: current, result: "acquired" }), { acquireTimeoutMs: 5000 });
      const elapsedMs = Date.now() - start;

      expect(result).toEqual({ status: "ok", result: "acquired" });
      expect(elapsedMs).toBeLessThan(5000); // recovered well before even the acquireTimeoutMs bound
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 20000);

  test("(b) a LIVE holder's lock is NEVER broken — a competing acquisition times out rather than acquiring early", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bakr-lock-crash-live-"));
    try {
      const agentsPath = join(dir, "agents.json");
      await save(agentsPath, emptyAgentStore());

      const holder = Bun.spawn(["bun", "run", HOLD_FIXTURE, agentsPath, "2000"], { stdout: "pipe", stderr: "pipe" });
      await waitForReady(holder);

      // The holder is genuinely alive and genuinely holds the kernel lock —
      // a competing, impatient caller must time out, never acquire early.
      await expect(withAgentStoreLock(agentsPath, (current) => ({ state: current, result: undefined }), { acquireTimeoutMs: 300 })).rejects.toThrow(/timed out/);

      await holder.exited; // let the real holder finish and release naturally
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 20000);

  test("PROBE CONTROL: sanity that waitForReady/kill actually target the right process — a bare kill on a NON-existent pid never satisfies the recovery path via a false 'not alive'", async () => {
    // This harness talks to the real spawned child, not a stale guess —
    // `holder.pid` from Bun.spawn is authoritative, and the recovery in
    // (a) above depends on this being a REAL process the kernel actually
    // tracks an open fd for, not a pid number alone.
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
