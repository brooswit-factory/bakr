// Test fixture for AC14 (R-F.3), round 2 (review, PR #13): holds the SAME
// raw lock file `agent-lock-hold-worker.ts` uses, but ALSO flips the named
// agent to `off` partway through the hold, directly (bypassing
// `withAgentStoreLock` — this process already holds exclusivity via the
// raw lock file, the same way `agent-lock-hold-worker.ts` does).
//
// This is what makes AC14's two-process test a genuine regression guard
// rather than one that only agrees with itself: a competing decision
// worker that reads BEFORE attempting to acquire this lock (the exact
// mutation class R-F.3 forbids) observes the agent as still "on" — because
// the flip has not landed yet when it reads — and only blocks afterward,
// by which point it is too late for a stale decision to be corrected. A
// worker that reads (or re-reads) fresh state ONLY AFTER acquiring the
// lock observes "off", because by the time this process releases, the
// flip has already landed. Round 1's choreography (flip fully completed,
// THEN the decision worker starts) could not distinguish these two shapes,
// because both a stale and a fresh read would see "off" — this file closes
// that gap.
import { open, rm } from "node:fs/promises";
import { load, save } from "../../../src/agent-store-io";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const [, , agentsPathRaw, agentIdRaw, holdMsRaw] = process.argv;
if (!agentsPathRaw || !agentIdRaw || !holdMsRaw) {
  console.error("usage: bun run agent-lock-hold-and-flip-worker.ts <agentsPath> <agentId> <holdMs>");
  process.exit(2);
}
const agentsPath: string = agentsPathRaw;
const agentId: string = agentIdRaw;
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

  // Hold for the first half — long enough for a competing worker to have
  // started, done any PRE-lock read (the mutation this test exists to
  // catch would read here), and be blocked retrying lock acquisition.
  await sleep(holdMs / 2);

  const loaded = await load(agentsPath);
  if (loaded.status === "loaded") {
    const agent = loaded.state.agents[agentId];
    if (agent !== undefined) {
      const next = { ...loaded.state, agents: { ...loaded.state.agents, [agentId]: { ...agent, state: "off" as const } } };
      await save(agentsPath, next);
    }
  }

  // Hold for the second half — a competing worker's PRE-lock read (if any)
  // already happened before the flip above; this second sleep just keeps
  // the lock held a little past the flip so a correct (in-lock) reader
  // cannot possibly race the write itself.
  await sleep(holdMs / 2);

  await rm(lockPath, { force: true });
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
