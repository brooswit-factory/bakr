// AC14 (AMENDED R-F.3): re-validate the restore/launch DECISION inside the
// lock, not only the write — demonstrated as the two-process race the
// ticket names explicitly: an operator process flips agent X `off` between
// the daemon's cycle-start read and its `beginLaunch`.
//
// Falsifier, stated first: if the decision is made from state read OUTSIDE
// the lock (the pre-fix shape, or a future regression that reintroduces
// it), X is launched anyway — the operator's `off` landed before the
// decision's lock acquisition, but the decision had already cached a stale
// "on" read from before that point. Negative control, in the SAME harness:
// the FIXED path (the real, exported `decideAndBeginForAgent`) does NOT
// launch X under the identical race timing.
//
// REVIEW HISTORY (PR #13), because this file's own discriminating power
// was wrong twice before landing:
// - Round 1: the "fixed" arm was a hand-written replica of the discipline,
//   never calling `src/daemon.ts` at all — fixed by exporting
//   `decideAndBeginForAgent` and calling it directly.
// - Round 2: even calling the real function, the "fixed" test's
//   choreography had the flip-off complete FULLY before the decision
//   worker ever started — so a stale pre-lock read and a fresh in-lock
//   read would observe the SAME state ("off" either way) and the test
//   could not tell them apart. Verified by the reviewer via a scratch
//   mutation (moving the read outside the lock) that still passed all 264
//   tests including this one.
// The fix (this version): `agent-lock-hold-and-flip-worker.ts` holds the
// real lock file and flips the agent to `off` PARTWAY THROUGH its hold —
// after a competing decision worker has had time to start and perform any
// PRE-lock read, but before that lock is released. This makes the two
// shapes diverge: a decision that reads before attempting to acquire the
// lock observes "on" (the flip hasn't landed yet) and, having cached that,
// launches once it finally gets the lock; a decision that reads ONLY AFTER
// acquiring the lock (the real, shipped behaviour) observes "off" and
// skips, because by the time it acquires the lock the flip has already
// landed and been released.
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyAgentStore, putAgent, type AgentRecord } from "../../src/agent-model";
import { save } from "../../src/agent-store-io";
import type { ClaimKey } from "../../src/claim-key-resolve";

const DECIDE_FIXTURE = join(import.meta.dir, "fixtures", "agent-decide-fresh-launch-worker.ts");
const FLIP_OFF_FIXTURE = join(import.meta.dir, "fixtures", "agent-flip-off-worker.ts");
const HOLD_AND_FLIP_FIXTURE = join(import.meta.dir, "fixtures", "agent-lock-hold-and-flip-worker.ts");
const KEY = "/claimed/dir" as ClaimKey;
const AGENT_ID = "@race-agent";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runFixture(scriptPath: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["bun", "run", scriptPath, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) throw new Error(`fixture ${scriptPath} exited ${exitCode}\nstdout: ${stdout}\nstderr: ${stderr}`);
  return stdout.trim();
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

async function seedOnAgent(agentsPath: string): Promise<void> {
  const agent: AgentRecord = { id: AGENT_ID, name: undefined, directory: KEY, state: "on", createdAt: 1, birthSessionId: undefined, restoreTarget: undefined };
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

  test("FIXED, GENUINELY INTERLEAVED: the flip lands while the real decision function is blocked on lock acquisition — it re-reads fresh after acquiring and SKIPS", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bakr-decide-race-fixed-interleaved-"));
    try {
      const agentsPath = join(dir, "agents.json");
      await seedOnAgent(agentsPath);

      // The hold-and-flip worker takes the real lock file immediately, then
      // flips the agent off at its own hold's midpoint, then releases.
      const holder = Bun.spawn(["bun", "run", HOLD_AND_FLIP_FIXTURE, agentsPath, AGENT_ID, "400"], { stdout: "pipe", stderr: "pipe" });
      await waitForReady(holder);

      // Start the REAL decision function's worker while the lock is held —
      // it will attempt to acquire immediately (any pre-lock read, were one
      // to exist, would happen right here, before the flip at ~200ms) and
      // then block, retrying, until the holder releases at ~400ms — by
      // which point the flip has already landed.
      const decideOutput = await runFixture(DECIDE_FIXTURE, ["fixed", agentsPath, AGENT_ID, KEY]);
      await holder.exited;

      expect(decideOutput).toBe("SKIPPED");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 15000);

  test("sanity: the SAME interleaving fixture, with NO flip (agent stays on throughout), DOES launch — the control that proves the interleaved test above can observe the positive case too", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bakr-decide-race-fixed-interleaved-control-"));
    try {
      const agentsPath = join(dir, "agents.json");
      await seedOnAgent(agentsPath);

      // No hold-and-flip worker at all this time — the agent is simply on, unmolested.
      const decideOutput = await runFixture(DECIDE_FIXTURE, ["fixed", agentsPath, AGENT_ID, KEY]);
      expect(decideOutput).toBe("LAUNCHED");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 15000);
});
