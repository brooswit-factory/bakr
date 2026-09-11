// Test fixture for AC1: runs `loadOrMigrateAgentStore` in a genuinely
// separate `bun` process and prints the resulting agents' ids, sorted, as
// JSON — so the test can compare two independent process runs against the
// SAME store and confirm the SECOND run mints nothing (identical ids).
import { loadOrMigrateAgentStore } from "../../../src/agent-store-migrate";
import { randomBytes } from "node:crypto";

const [, , agentsPathRaw, sessionSlotsPathRaw] = process.argv;
if (!agentsPathRaw || !sessionSlotsPathRaw) {
  console.error("usage: bun run migrate-and-print-ids.ts <agentsPath> <sessionSlotsPath>");
  process.exit(2);
}
const agentsPath: string = agentsPathRaw;
const sessionSlotsPath: string = sessionSlotsPathRaw;

async function main(): Promise<void> {
  const outcome = await loadOrMigrateAgentStore({
    agentsPath,
    sessionSlotsPath,
    now: () => Date.now(),
    randomBytes: (n: number) => new Uint8Array(randomBytes(n)),
  });
  if (outcome.status === "malformed") {
    console.error(`malformed: ${outcome.error}`);
    process.exit(1);
  }
  console.log(JSON.stringify({ status: outcome.status, ids: Object.keys(outcome.state.agents).sort() }));
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
