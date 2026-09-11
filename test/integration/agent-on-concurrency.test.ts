// DoD item 4: exactly one launch on `on` under real concurrent callers,
// with real OS processes, plus a negative control proving the probe can
// actually detect a double launch. "Two processes is not a concurrency
// test for anything whose failure needs three parties" (BAKR-16's own
// lesson) — this uses 8 real, concurrent OS processes racing `on()` for
// the SAME off agent in the SAME directory, all contending for the SAME
// kernel flock on agents.json.
//
// Falsifier, stated first: if the real `on()` ever issues more than one
// launch for this agent under this race, the positive test below fails.
// Negative control: the SAME race, run against a deliberately-broken
// reimplementation that decides off -> on from an unlocked peek and skips
// both the re-validation-inside-the-lock discipline (R-F.3) and the
// hasLaunchRecordFor guard — proving this harness CAN observe more than
// one launch when the guard is actually missing, not just when it happens
// to hold.

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyAgentStore, putAgent, type AgentRecord } from "../../src/agent-model";
import { save } from "../../src/agent-store-io";
import { load } from "../../src/agent-store-io";
import type { ClaimKey } from "../../src/claim-key-resolve";

const WORKER_FIXTURE = join(import.meta.dir, "fixtures", "agent-on-race-worker.ts");
const KEY = "/claimed/dir" as ClaimKey;
const AGENT_ID = "@race-on-agent0000";
const CONTENDERS = 8;

async function seedOffAgent(agentsPath: string): Promise<void> {
  const agent: AgentRecord = { id: AGENT_ID, name: undefined, directory: KEY, state: "off", createdAt: 1, durableSessionId: undefined, liveSessionId: undefined };
  await save(agentsPath, putAgent(emptyAgentStore(), agent));
}

async function runWorker(mode: "safe" | "broken", agentsPath: string): Promise<{ launched: boolean }> {
  const proc = Bun.spawn(["bun", "run", WORKER_FIXTURE, mode, agentsPath, AGENT_ID, KEY], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) throw new Error(`worker exited ${exitCode}\nstdout: ${stdout}\nstderr: ${stderr}`);
  return JSON.parse(stdout.trim());
}

describe("AC4: exactly one launch on `on` under real concurrent OS processes", () => {
  test(`NEGATIVE CONTROL: ${CONTENDERS} real processes racing the deliberately-broken arm (no re-validation inside the lock, no hasLaunchRecordFor guard) produce MORE THAN ONE launch`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "bakr-on-race-broken-"));
    try {
      const agentsPath = join(dir, "agents.json");
      await seedOffAgent(agentsPath);

      const results = await Promise.all(Array.from({ length: CONTENDERS }, () => runWorker("broken", agentsPath)));
      const launchedCount = results.filter((r) => r.launched).length;

      // The falsifier for THIS test: if the harness cannot make the broken
      // arm double-launch, it has no power to discriminate anything, and
      // the positive test below would be meaningless.
      expect(launchedCount).toBeGreaterThan(1);

      const loaded = await load(agentsPath);
      if (loaded.status === "loaded") {
        const launchRecordsForAgent = loaded.state.launches.filter((l) => l.agentId === AGENT_ID);
        expect(launchRecordsForAgent.length).toBeGreaterThan(1); // more than one launch record was created for the same agent
      } else {
        throw new Error("expected a loaded store");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 20000);

  test(`POSITIVE, REAL: ${CONTENDERS} real processes racing the SHIPPED on() produce EXACTLY ONE launch`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "bakr-on-race-safe-"));
    try {
      const agentsPath = join(dir, "agents.json");
      await seedOffAgent(agentsPath);

      const results = await Promise.all(Array.from({ length: CONTENDERS }, () => runWorker("safe", agentsPath)));
      const launchedCount = results.filter((r) => r.launched).length;

      expect(launchedCount).toBe(1);

      const loaded = await load(agentsPath);
      if (loaded.status === "loaded") {
        expect(loaded.state.agents[AGENT_ID]?.state).toBe("on");
        const launchRecordsForAgent = loaded.state.launches.filter((l) => l.agentId === AGENT_ID);
        expect(launchRecordsForAgent.length).toBe(1); // exactly one launch record, never duplicated
      } else {
        throw new Error("expected a loaded store");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 20000);
});
