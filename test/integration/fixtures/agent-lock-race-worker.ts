// Test fixture, not a demonstration for reviewers and not the CLI — see
// claim-and-save.ts's own header for why this repo keeps such scripts
// under test/integration/fixtures/ rather than scripts/. Spawned as a
// genuinely separate `bun` process by
// test/integration/agent-store-lock-race.test.ts (BAKR-16 R-F, AC8): each
// invocation adds `count` distinct agent records to the SAME store at
// `agentsPath`, either through `withAgentStoreLock` ("locked") or via a raw,
// unprotected load-modify-save ("unlocked") — the exact lost-update shape
// R-F's own module comment describes. A deliberate small delay between the
// unlocked load and its save widens the race window so two real,
// concurrently-running OS processes reliably interleave within this
// fixture's short runtime, rather than leaving the outcome to chance.
import { emptyAgentStore, putAgent, type AgentRecord } from "../../../src/agent-model";
import { load, save, withAgentStoreLock } from "../../../src/agent-store-io";
import type { ClaimKey } from "../../../src/claim-key-resolve";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const [, , modeRaw, agentsPathRaw, countRaw, workerIdRaw] = process.argv;
if ((modeRaw !== "locked" && modeRaw !== "unlocked") || !agentsPathRaw || !countRaw || !workerIdRaw) {
  console.error("usage: bun run agent-lock-race-worker.ts <locked|unlocked> <agentsPath> <count> <workerId>");
  process.exit(2);
}
const mode: "locked" | "unlocked" = modeRaw;
const agentsPath: string = agentsPathRaw;
const workerId: string = workerIdRaw;
const count = Number(countRaw);

function makeAgent(id: string): AgentRecord {
  return { id, name: undefined, directory: "/race" as ClaimKey, state: "on", createdAt: 1, durableSessionId: undefined, liveSessionId: undefined };
}

async function main(): Promise<void> {
  for (let i = 0; i < count; i++) {
    const id = `@${workerId}-${i}`;
    if (mode === "locked") {
      await withAgentStoreLock(agentsPath, (current) => ({ state: putAgent(current, makeAgent(id)), result: undefined }));
    } else {
      const loaded = await load(agentsPath);
      const state = loaded.status === "loaded" ? loaded.state : emptyAgentStore();
      await sleep(15); // deliberately widen the unprotected window between load and save
      const next = putAgent(state, makeAgent(id));
      await save(agentsPath, next);
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
