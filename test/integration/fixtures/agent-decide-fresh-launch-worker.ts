// Test fixture for AC14 (R-F.3). The "fixed" mode calls daemon.ts's own
// EXPORTED `decideAndBeginForAgent` directly — not a hand-written replica
// of its discipline — so this test binds to the actual shipped decision
// boundary: if a future edit ever moves the read outside the lock, this
// test regresses (review, PR #13, round 1: the original version of this
// fixture reimplemented the discipline inline, which meant the assertion
// never actually exercised src/daemon.ts at all).
//
// The "naive" mode is, deliberately, still a hand-written reproduction of
// the OLD, pre-fix shape (decide OUTSIDE any lock, sleep, then blindly
// write) — there is no "naive" function in src/ to call, because the whole
// point is that shape was never shipped. This is test-only code modeling a
// bug class, not a stand-in for production code.
import { decideAndBeginForAgent, type DaemonDeps } from "../../../src/daemon";
import { load, withAgentStoreLock } from "../../../src/agent-store-io";
import { beginLaunch, hasLaunchRecordFor } from "../../../src/agent-model";
import type { ClaimKey } from "../../../src/claim-key-resolve";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const [, , modeRaw, agentsPathRaw, agentIdRaw, keyRaw] = process.argv;
if ((modeRaw !== "fixed" && modeRaw !== "naive") || !agentsPathRaw || !agentIdRaw || !keyRaw) {
  console.error("usage: bun run agent-decide-fresh-launch-worker.ts <fixed|naive> <agentsPath> <agentId> <key>");
  process.exit(2);
}
const mode: "fixed" | "naive" = modeRaw;
const agentsPath: string = agentsPathRaw;
const agentId: string = agentIdRaw;
const key = keyRaw as ClaimKey;

function unusedDeps(): DaemonDeps {
  // decideAndBeginForAgent only reads deps.agentsPath, deps.generateAttemptId, deps.now, and the optional lock-tuning fields — the rest of DaemonDeps is structurally required but never touched by this call, so these are harmless placeholders, never exercised.
  return {
    runCommand: () => {
      throw new Error("unused by decideAndBeginForAgent");
    },
    claimsPath: "/unused",
    agentsPath,
    sessionSlotsPath: "/unused",
    now: () => 1,
    generateAttemptId: () => "fixed-attempt",
    randomBytes: () => new Uint8Array(0),
    probeDeps: {
      stat: () => {
        throw new Error("unused by decideAndBeginForAgent");
      },
    },
  };
}

async function main(): Promise<void> {
  if (mode === "fixed") {
    // Calls the REAL, exported production function — no reimplementation.
    const outcome = await decideAndBeginForAgent(unusedDeps(), agentId, key, []);
    if (outcome.malformed) {
      console.log("MALFORMED");
      return;
    }
    console.log(outcome.decision?.kind === "begin-fresh-launch" ? "LAUNCHED" : "SKIPPED");
    return;
  }

  // The NAIVE (pre-fix, never-shipped) shape: decide from an UNLOCKED read, sleep (simulating time spent elsewhere in an old-style cycle), THEN take the lock to blindly write — never re-checking.
  const loaded = await load(agentsPath);
  const state = loaded.status === "loaded" ? loaded.state : undefined;
  const agent = state?.agents[agentId];
  const decidedToLaunch = agent !== undefined && agent.state === "on" && !hasLaunchRecordFor(state!, agentId, undefined);
  await sleep(150); // the race window: an operator's write can land here, and the naive code never notices
  if (!decidedToLaunch) {
    console.log("SKIPPED");
    return;
  }
  await withAgentStoreLock(agentsPath, (current) => ({ state: beginLaunch(current, agentId, key, undefined, "naive-attempt", 1), result: undefined }));
  console.log("LAUNCHED");
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
