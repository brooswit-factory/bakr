// EXPLICITLY PROVISIONAL demonstration harness (BAKR-12, updated BAKR-19) —
// NOT a CLI grammar. See demo-claim.ts's own banner comment. Updated to
// exercise the agent store (agent-model.ts / agent-store-io.ts) rather than
// the session-slots store it subsumes (B1) — same spirit as before: give
// the daemon (src/index.ts) something real to reconcile against, via the
// SAME real spawn substrate and the SAME `withAgentStoreLock` discipline the
// daemon itself uses (R-F: "every mutation of agents.json — the daemon's
// and the harness's alike — goes through one helper"), never a shortcut.
//
// This script performs exactly two things, neither of them a lifecycle
// verb (create/on/off/rename/archive/unarchive/delete/adopt are a sibling
// story — see BAKR-16 §3):
//
//   bun run scripts/demo-put-on.ts <directory>
//     Mints a fresh, unnamed `on` agent with no session yet, then performs
//     ONE fresh launch for it and resolves its session id (a second listing,
//     immediately — fine for a one-shot script, see the daemon's own
//     one-listing-per-cycle comment in daemon.ts for why that budget does
//     NOT apply here).
//
//   bun run scripts/demo-put-on.ts <directory> --agent <agentId>
//     Performs ONE restore launch (--resume <durableSessionId>) for an
//     EXISTING `on` agent already holding a session — the same path the
//     daemon's own reconcile loop takes when it finds that agent's session
//     absent from a listing.
//
// Unlike the daemon's own reconcile cycle, this is a one-shot script, not a
// running loop.

import { lstat, readlink } from "node:fs/promises";
import { homedir } from "node:os";
import { lookup } from "../src/claim-model";
import { load as loadClaims } from "../src/claim-store-io";
import { resolveClaimKey } from "../src/claim-key-resolve";
import { lexicallyNormalize } from "../src/claim-key";
import { claimsPath, agentsPath, realRandomBytes } from "../src/paths";
import { withAgentStoreLock } from "../src/agent-store-io";
import { beginLaunch, markLaunchFailed, markLaunchStarted, mintUniqueAgentId, putAgent, resolveAgent, resolveLaunch, type AgentRecord } from "../src/agent-model";
import { launch, listBackgroundSessions, runCommand } from "../src/spawn";

function parseArgs(argv: string[]): { directory: string; agentId: string | undefined } {
  const directory = argv[0];
  if (directory === undefined) {
    console.error("usage: bun run scripts/demo-put-on.ts <directory> [--agent <agentId>]");
    process.exit(1);
  }
  let agentId: string | undefined;
  const idx = argv.indexOf("--agent");
  if (idx !== -1) {
    agentId = argv[idx + 1];
    if (agentId === undefined) {
      console.error("--agent requires an agent id");
      process.exit(1);
    }
  }
  return { directory, agentId };
}

async function main(): Promise<void> {
  const { directory, agentId } = parseArgs(process.argv.slice(2));

  const lexical = lexicallyNormalize(directory, { cwd: process.cwd(), home: homedir() });
  const resolved = await resolveClaimKey(lexical, { lstat, readlink });
  if (!resolved.ok) {
    console.error(`could not resolve "${directory}": ${resolved.reason}${"message" in resolved ? `: ${resolved.message}` : ""}`);
    process.exit(1);
  }
  const key = resolved.key;

  const claimsLoaded = await loadClaims(claimsPath());
  if (claimsLoaded.status !== "loaded" || lookup(claimsLoaded.state, key) === undefined) {
    console.error(`"${key}" is not claimed — run scripts/demo-claim.ts first`);
    process.exit(1);
  }

  const path = agentsPath();
  let attemptId: string;
  let priorSessionId: string | undefined;
  let targetAgentId: string;

  if (agentId !== undefined) {
    // Restore path: the named agent must already exist, in THIS directory, with a durable session id.
    const decision = await withAgentStoreLock<{ ok: true; attemptId: string; sessionId: string } | { ok: false; error: string }>(path, (current) => {
      const outcome = resolveAgent(current, key, agentId);
      if (outcome.outcome === "not-found") return { state: current, result: { ok: false, error: `no agent "${agentId}" found in "${key}"` } };
      if (outcome.outcome === "found-elsewhere") return { state: current, result: { ok: false, error: `agent "${agentId}" belongs to a different directory: "${outcome.directory}"` } };
      const agent = outcome.agent;
      if (agent.durableSessionId === undefined) return { state: current, result: { ok: false, error: `agent "${agentId}" has no session yet — omit --agent to mint a fresh one` } };
      const newAttemptId = crypto.randomUUID();
      const next = beginLaunch(current, agent.id, key, agent.durableSessionId, newAttemptId, Date.now());
      return { state: next, result: { ok: true, attemptId: newAttemptId, sessionId: agent.durableSessionId } };
    });
    if (decision.status === "malformed") {
      console.error(`refusing to write: agent store at "${path}" is malformed: ${decision.error}`);
      process.exit(1);
    }
    if (!decision.result.ok) {
      console.error(decision.result.error);
      process.exit(1);
    }
    attemptId = decision.result.attemptId;
    priorSessionId = decision.result.sessionId;
    targetAgentId = agentId;
  } else {
    // Fresh path: mint a brand-new, unnamed `on` agent with no session yet.
    const decision = await withAgentStoreLock<{ attemptId: string; agentId: string }>(path, (current) => {
      const id = mintUniqueAgentId(current, realRandomBytes);
      const agent: AgentRecord = { id, name: undefined, directory: key, state: "on", createdAt: Date.now(), durableSessionId: undefined, liveSessionId: undefined };
      let next = putAgent(current, agent);
      const newAttemptId = crypto.randomUUID();
      next = beginLaunch(next, id, key, undefined, newAttemptId, Date.now());
      return { state: next, result: { attemptId: newAttemptId, agentId: id } };
    });
    if (decision.status === "malformed") {
      console.error(`refusing to write: agent store at "${path}" is malformed: ${decision.error}`);
      process.exit(1);
    }
    attemptId = decision.result.attemptId;
    targetAgentId = decision.result.agentId;
    console.log(`minted: unnamed agent ${targetAgentId} in "${key}"`);
  }

  const claudeArgs = priorSessionId !== undefined ? ["--resume", priorSessionId] : [];
  const result = await launch(key, claudeArgs, { runCommand });
  if (!result.ok) {
    await withAgentStoreLock(path, (current) => ({ state: markLaunchFailed(current, attemptId, result.error), result: undefined }));
    console.error(`launch failed: ${result.error}`);
    process.exit(1);
  }
  await withAgentStoreLock(path, (current) => ({ state: markLaunchStarted(current, attemptId, result.id), result: undefined }));
  console.log(`launched: short id ${result.id} for agent ${targetAgentId} in "${key}"${priorSessionId !== undefined ? ` (resumed from ${priorSessionId})` : ""}`);

  const sessions = await listBackgroundSessions({ runCommand });
  const listed = sessions.find((s) => s.id === result.id);
  if (listed === undefined) {
    console.log(`not yet visible in \`claude agents --json\` — it will resolve on the daemon's next reconcile cycle, or re-run this listing later`);
    return;
  }
  const afterResolve = await withAgentStoreLock<AgentRecord | undefined>(path, (current) => {
    const next = resolveLaunch(current, result.id, listed.sessionId);
    return { state: next, result: next.agents[targetAgentId] };
  });
  if (afterResolve.status === "ok" && afterResolve.result !== undefined) {
    console.log(`resolved: agent ${targetAgentId} now holds durable session ${afterResolve.result.durableSessionId}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
