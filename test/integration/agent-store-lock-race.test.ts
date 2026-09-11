// AC7 (R-F, B12): the lost-update demonstration, as TWO REAL OS PROCESSES —
// an in-process race proves nothing about the failure mode being guarded
// (an in-process test is covered separately, for extra confidence, in
// agent-store-io.test.ts, but is NOT a substitute for this file).
//
// Falsifier, stated first: if the write discipline is broken, running two
// concurrent WORKER PROCESSES that each add N distinct agent records to the
// SAME store, unprotected, loses at least one of those additions (the final
// agent count is less than 2N). Negative control, in the SAME harness: the
// identical two processes, going through `withAgentStoreLock` instead,
// never lose one (the final count is exactly 2N).
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "../../src/agent-store-io";

const FIXTURE = join(import.meta.dir, "fixtures", "agent-lock-race-worker.ts");
const PER_WORKER_COUNT = 25;

async function runWorker(mode: "locked" | "unlocked", agentsPath: string, workerId: string): Promise<void> {
  const proc = Bun.spawn(["bun", "run", FIXTURE, mode, agentsPath, String(PER_WORKER_COUNT), workerId], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) {
    throw new Error(`worker ${workerId} (${mode}) exited ${exitCode}\nstdout: ${stdout}\nstderr: ${stderr}`);
  }
}

describe("AC7: the lost-update demonstration — two REAL OS processes, with the negative control", () => {
  test("NEGATIVE CONTROL: without the lock, two concurrent processes writing to the SAME store LOSE at least one update", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bakr-lock-race-unlocked-"));
    try {
      const agentsPath = join(dir, "agents.json");
      await Promise.all([runWorker("unlocked", agentsPath, "w1"), runWorker("unlocked", agentsPath, "w2")]);

      const result = await load(agentsPath);
      expect(result.status).toBe("loaded");
      if (result.status !== "loaded") return;
      const finalCount = Object.keys(result.state.agents).length;
      // The falsifier: an unprotected read-sleep-write race between two real processes must lose at least one of the 2*PER_WORKER_COUNT additions.
      expect(finalCount).toBeLessThan(PER_WORKER_COUNT * 2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);

  test("FIXED: with withAgentStoreLock, two concurrent processes writing to the SAME store lose NOTHING — every addition survives", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bakr-lock-race-locked-"));
    try {
      const agentsPath = join(dir, "agents.json");
      await Promise.all([runWorker("locked", agentsPath, "w1"), runWorker("locked", agentsPath, "w2")]);

      const result = await load(agentsPath);
      expect(result.status).toBe("loaded");
      if (result.status !== "loaded") return;
      const finalCount = Object.keys(result.state.agents).length;
      expect(finalCount).toBe(PER_WORKER_COUNT * 2); // every single addition from both real processes survived
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);
});
