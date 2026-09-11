// Test fixture for AC15 (R-F.4): a real, separate `bun` process that
// acquires the agent store's lock and holds it for `holdMs`, doing nothing
// else — used both as a "kill -9 me mid-hold" target and as a genuinely
// live, healthy holder for the negative-control direction. Prints "READY"
// as soon as the lock is held (so the parent test knows it is safe to
// either `kill -9` it or attempt a competing acquisition), then sleeps.
//
// Reaches directly into agent-store-io.ts's lock file convention
// (`<path>.lock`, JSON `{pid, acquiredAt}`) rather than going through
// `withAgentStoreLock` — deliberately, since that helper's own mutate
// callback is synchronous and cannot hold the lock open across an
// arbitrary sleep. This fixture is standing in for "a real process holding
// the lock for a while", not for any lifecycle verb.
import { open } from "node:fs/promises";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const [, , agentsPathRaw, holdMsRaw] = process.argv;
if (!agentsPathRaw || !holdMsRaw) {
  console.error("usage: bun run agent-lock-hold-worker.ts <agentsPath> <holdMs>");
  process.exit(2);
}
const agentsPath: string = agentsPathRaw;
const holdMs = Number(holdMsRaw);
const lockPath = `${agentsPath}.lock`;

async function main(): Promise<void> {
  const handle = await open(lockPath, "wx");
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }), "utf8");
  } finally {
    await handle.close();
  }
  console.log("READY");
  await sleep(holdMs);
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
