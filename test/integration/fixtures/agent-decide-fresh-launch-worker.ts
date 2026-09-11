// Test fixture for AC14 (R-F.3): exercises daemon.ts's `decideAndBeginForAgent`
// re-validation-inside-the-lock discipline directly, via a real, separate
// `bun` process racing against another real process (agent-flip-off-worker.ts)
// that turns the agent `off`. Prints "LAUNCHED" or "SKIPPED" as its last
// stdout line so the test can tell which happened without re-reading the
// store itself (avoiding a third source of truth in the assertion).
//
// Also used to reproduce the OLD, pre-fix shape for the negative control:
// with `--naive`, this fixture reads the decision OUTSIDE any lock, sleeps
// (simulating the time an old-style cycle would spend elsewhere before
// reaching beginLaunch), and only then takes the lock to blindly begin the
// launch WITHOUT re-checking — reproducing exactly the race R-F.3 exists to
// close. This is test-only code; nothing resembling it ships in src/.
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

async function main(): Promise<void> {
  if (mode === "fixed") {
    // The REAL discipline: decision AND write inside ONE lock hold.
    const result = await withAgentStoreLock(agentsPath, (current) => {
      const agent = current.agents[agentId];
      if (agent === undefined || agent.state !== "on" || hasLaunchRecordFor(current, agentId, undefined)) {
        return { state: current, result: "SKIPPED" as const };
      }
      const next = beginLaunch(current, agentId, key, undefined, "fixed-attempt", 1);
      return { state: next, result: "LAUNCHED" as const };
    });
    console.log(result.status === "ok" ? result.result : "MALFORMED");
    return;
  }

  // The NAIVE (pre-fix) shape: decide from an UNLOCKED read, sleep (simulating time spent elsewhere in an old-style cycle), THEN take the lock to blindly write — never re-checking.
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
