// One-off repair: point an agent's restore target at a session that has a
// transcript. Needed when a chain of `--fork-session` relaunches left the
// target on a fork that was never prompted (no transcript, nothing to
// resume) while the conversation lives in an earlier session. Uses the
// store's own lock and model; refuses unless the session's transcript exists.
//
//   bun run scripts/repoint-restore-target.ts <@agentId> <sessionId>

import { withAgentStoreLock } from "../src/agent-store-io";
import { putAgent } from "../src/agent-model";
import { agentsPath, realTranscriptProbeDeps } from "../src/paths";
import { probeResumableTranscript } from "../src/transcript-probe";

const [agentId, sessionId] = process.argv.slice(2);
if (!agentId || !sessionId) {
  console.error("usage: repoint-restore-target.ts <@agentId> <sessionId>");
  process.exit(2);
}
const probe = await probeResumableTranscript(sessionId, realTranscriptProbeDeps);
if (probe.status !== "has-transcript") {
  console.error(`refusing: session ${sessionId} has no resumable transcript (${probe.status})`);
  process.exit(1);
}
const result = await withAgentStoreLock(agentsPath(), (current) => {
  const agent = current.agents[agentId];
  if (agent === undefined) return { state: current, result: `no agent ${agentId}` };
  const before = agent.restoreTarget;
  return { state: putAgent(current, { ...agent, restoreTarget: { sessionId, shortId: sessionId.slice(0, 8) } }), result: `${agentId}: restoreTarget ${before?.sessionId ?? "none"} -> ${sessionId}` };
});
console.log(result.status === "malformed" ? `store malformed: ${result.error}` : result.result);
