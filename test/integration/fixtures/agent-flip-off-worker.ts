// Test fixture for AC14 (R-F.3): a real, separate `bun` process simulating
// an operator turning an agent `off` — waits `delayMs`, then flips the
// named agent's `state` to "off" via the real, correctly-locked mutation
// path (`withAgentStoreLock`), exactly as a future `off` verb would.
import { withAgentStoreLock } from "../../../src/agent-store-io";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const [, , agentsPathRaw, agentIdRaw, delayMsRaw] = process.argv;
if (!agentsPathRaw || !agentIdRaw || !delayMsRaw) {
  console.error("usage: bun run agent-flip-off-worker.ts <agentsPath> <agentId> <delayMs>");
  process.exit(2);
}
const agentsPath: string = agentsPathRaw;
const agentId: string = agentIdRaw;
const delayMs = Number(delayMsRaw);

async function main(): Promise<void> {
  await sleep(delayMs);
  await withAgentStoreLock(agentsPath, (current) => {
    const agent = current.agents[agentId];
    if (agent === undefined) return { state: current, result: undefined };
    return { state: { ...current, agents: { ...current.agents, [agentId]: { ...agent, state: "off" as const } } }, result: undefined };
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
