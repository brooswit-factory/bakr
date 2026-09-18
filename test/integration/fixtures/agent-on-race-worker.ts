// Fixture for AC4 (exactly one launch on `on` under real concurrent
// callers): a real OS process that either calls the REAL, shipped `on()`
// ("safe") or a deliberately-broken reimplementation ("broken") that skips
// the guard the real code has — re-checking `hasLaunchRecordFor` INSIDE the
// same lock hold as the state write. The broken arm exists ONLY to prove
// this harness can actually detect a double launch (the negative control
// AC4 explicitly asks for) — it is not reachable from any production code
// path.
//
// Prints a single JSON line to stdout: `{ launched: boolean }`.

import { withAgentStoreLock } from "../../../src/agent-store-io";
import { beginLaunch, hasLaunchRecordFor, putAgent, type AgentRecord } from "../../../src/agent-model";
import { on, type AgentActionDeps } from "../../../src/agent-actions";
import type { ClaimKey } from "../../../src/claim-key-resolve";
import { makeFakeHost } from "../../support/fake-host";

async function fakeLaunchOk(): Promise<{ ok: true; id: string }> {
  return { ok: true, id: `short-${process.pid}` };
}

function baseDeps(agentsPath: string): AgentActionDeps {
  return {
    agentsPath,
    // BAKR-22: `on`'s "safe" path now ALWAYS fetches a listing first (before
    // deciding anything, including for a `fresh` plan that has no session
    // to check liveness against yet) — a behavior change from the pre-BAKR-22
    // code this fixture originally modeled (which only ever called
    // `launch()`). This fixture's agent is seeded fresh (no restoreTarget),
    // so the listing's actual content is irrelevant to the race being
    // tested; an empty host is enough to let `on()` proceed to its `fresh`
    // branch. The launch itself runs through the shared fake herdr host
    // (one per process: each process's own launch lands in its own fake).
    runCommand: makeFakeHost().runCommand,
    now: () => Date.now(),
    generateAttemptId: () => `attempt-${process.pid}-${Date.now()}-${Math.random()}`,
    randomBytes: (n: number) => new Uint8Array(n).fill(process.pid & 0xff),
  };
}

/**
 * The DELIBERATELY BROKEN arm: reads (peeks) the store UNLOCKED, decides
 * off -> on from that stale peek, then — inside a lock hold — blindly
 * writes `state: "on"` and calls `beginLaunch` WITHOUT re-checking either
 * the agent's current state or `hasLaunchRecordFor` against the FRESH,
 * lock-held read. This is exactly the class of bug BAKR-16's own AC14 targets
 * (a decision made outside the lock, carried stale into the write) plus a
 * missing double-launch guard — never present in the shipped `on()`.
 */
async function brokenOn(deps: AgentActionDeps, directory: ClaimKey, agentId: string): Promise<boolean> {
  const { load } = await import("../../../src/agent-store-io");
  const peeked = await load(deps.agentsPath);
  if (peeked.status !== "loaded") return false;
  const agent = peeked.state.agents[agentId];
  if (agent === undefined || agent.state !== "off") return false;

  let launched = false;
  await withAgentStoreLock(deps.agentsPath, (current) => {
    const currentAgent = current.agents[agentId] as AgentRecord;
    // BROKEN: no re-check of currentAgent.state, no hasLaunchRecordFor guard.
    const next = putAgent(current, { ...currentAgent, state: "on" });
    const attemptId = deps.generateAttemptId();
    const withLaunch = beginLaunch(next, agentId, directory, undefined, attemptId, deps.now());
    launched = true;
    return { state: withLaunch, result: undefined };
  });
  if (launched) await fakeLaunchOk();
  return launched;
}

/**
 * Spins/sleeps until `targetEpochMs`, so every contender's first read of
 * the store happens at approximately the SAME wall-clock instant
 * regardless of each process's own startup jitter (`Bun.spawn` + the JS
 * runtime boot itself can easily vary by tens of milliseconds under load,
 * which a fixed random sleep chosen independently by each process cannot
 * compensate for). Same technique BAKR-16's own 12-contender lock test
 * describes as "each spinning to a shared start instant".
 */
async function waitUntil(targetEpochMs: number): Promise<void> {
  const remaining = targetEpochMs - Date.now();
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
}

async function main(): Promise<void> {
  const [mode, agentsPath, agentId, directory, targetStartEpochMsRaw] = process.argv.slice(2);
  if (mode === undefined || agentsPath === undefined || agentId === undefined || directory === undefined) {
    console.error("usage: agent-on-race-worker.ts <safe|broken> <agentsPath> <agentId> <directory> [targetStartEpochMs]");
    process.exit(1);
  }
  if (targetStartEpochMsRaw !== undefined) {
    await waitUntil(Number(targetStartEpochMsRaw));
  }
  const deps = baseDeps(agentsPath);
  const key = directory as ClaimKey;

  if (mode === "safe") {
    const result = await on(deps, key, agentId);
    const launched = result.ok && result.launchIssued;
    console.log(JSON.stringify({ launched }));
    return;
  }
  if (mode === "broken") {
    const launched = await brokenOn(deps, key, agentId);
    console.log(JSON.stringify({ launched }));
    return;
  }
  console.error(`unknown mode "${mode}"`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
