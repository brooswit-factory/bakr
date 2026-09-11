// AC14 (AMENDED R-F.3): re-validate the restore/launch DECISION inside the
// lock, not only the write — demonstrated as the two-process race the
// ticket names explicitly: an operator process flips agent X `off` between
// the daemon's cycle-start read and its `beginLaunch`.
//
// Falsifier, stated first: if the decision is made from state read OUTSIDE
// the lock (the pre-fix shape), X is launched anyway — the operator's `off`
// landed in the window between the read and the write, and nothing
// re-checked. Negative control, in the SAME harness: the FIXED path (real
// production code, daemon.ts's own decision-inside-the-lock discipline)
// does NOT launch X under the identical race timing. Without this negative
// control, "X was not launched" could mean "the guard works" OR "the race
// never fired" — this file proves both arms with the same choreography.
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyAgentStore, putAgent, type AgentRecord } from "../../src/agent-model";
import { save } from "../../src/agent-store-io";
import type { ClaimKey } from "../../src/claim-key-resolve";

const DECIDE_FIXTURE = join(import.meta.dir, "fixtures", "agent-decide-fresh-launch-worker.ts");
const FLIP_OFF_FIXTURE = join(import.meta.dir, "fixtures", "agent-flip-off-worker.ts");
const KEY = "/claimed/dir" as ClaimKey;
const AGENT_ID = "@race-agent";

async function runFixture(scriptPath: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["bun", "run", scriptPath, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) throw new Error(`fixture ${scriptPath} exited ${exitCode}\nstdout: ${stdout}\nstderr: ${stderr}`);
  return stdout.trim();
}

async function seedOnAgent(agentsPath: string): Promise<void> {
  const agent: AgentRecord = { id: AGENT_ID, name: undefined, directory: KEY, state: "on", createdAt: 1, durableSessionId: undefined, liveSessionId: undefined };
  await save(agentsPath, putAgent(emptyAgentStore(), agent));
}

describe("AC14 (R-F.3): the restore/launch decision is re-validated inside the lock", () => {
  test("NEGATIVE CONTROL (naive, pre-fix shape): the operator's 'off' lands in the read-to-write window, and the agent IS launched anyway", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bakr-decide-race-naive-"));
    try {
      const agentsPath = join(dir, "agents.json");
      await seedOnAgent(agentsPath);

      const [decideOutput] = await Promise.all([
        runFixture(DECIDE_FIXTURE, ["naive", agentsPath, AGENT_ID, KEY]),
        runFixture(FLIP_OFF_FIXTURE, [agentsPath, AGENT_ID, "50"]), // flips off well inside the naive worker's 150ms sleep
      ]);

      expect(decideOutput).toBe("LAUNCHED"); // the race fired: launched an agent the operator had just turned off
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 15000);

  test("FIXED: when the flip-off's write demonstrably lands before the decision's lock is acquired, the decision reads it and SKIPS — proving the decision re-reads fresh, not the outer (stale) state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bakr-decide-race-fixed-deterministic-"));
    try {
      const agentsPath = join(dir, "agents.json");
      await seedOnAgent(agentsPath);

      // Flip off FIRST, fully, before the decision worker even starts — the
      // simplest possible proof that a lock-fresh read observes it (as
      // opposed to some earlier snapshot the decision might otherwise have
      // cached, which is exactly what the naive worker's failure mode does
      // under a delay).
      await runFixture(FLIP_OFF_FIXTURE, [agentsPath, AGENT_ID, "0"]);
      const decideOutput = await runFixture(DECIDE_FIXTURE, ["fixed", agentsPath, AGENT_ID, KEY]);
      expect(decideOutput).toBe("SKIPPED");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 15000);
});
