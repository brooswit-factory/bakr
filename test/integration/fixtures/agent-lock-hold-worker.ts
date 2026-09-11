// Test fixture for AC15 (R-F.4): a real, separate `bun` process that
// acquires the agent store's lock and holds it for `holdMs`, doing nothing
// else — used both as a "kill -9 me mid-hold" target and as a genuinely
// live, healthy holder for the negative-control direction. Prints "READY"
// as soon as the lock is held (so the parent test knows it is safe to
// either `kill -9` it or attempt a competing acquisition), then sleeps and
// releases cleanly on a normal exit (a `kill -9` skips the `finally` below
// entirely — the kernel releases the flock anyway the instant this
// process's fd closes, which is exactly the behaviour AC15(a) verifies).
//
// BAKR-20: goes through `acquireAgentStoreLockForFixture` — the SAME
// kernel lock production code takes — rather than reimplementing the lock
// convention by hand, since "the lock" is now an flock on an open fd, not
// a file whose CONTENT a fixture could plausibly stand in for.
// `withAgentStoreLock` itself is still not used here because its `mutate`
// callback is synchronous and cannot hold the lock open across an
// arbitrary sleep.
import { acquireAgentStoreLockForFixture } from "../../../src/agent-store-io";

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

async function main(): Promise<void> {
  const held = await acquireAgentStoreLockForFixture(agentsPath);
  console.log("READY");
  try {
    await sleep(holdMs);
  } finally {
    await held.release();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
