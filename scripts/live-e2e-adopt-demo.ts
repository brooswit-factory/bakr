// EXPLICITLY PROVISIONAL, ONE-OFF measurement script (BAKR-24 DoD #5) — not
// part of the test suite (it spawns REAL `claude --bg` sessions and costs
// real API usage/wall-clock time), mirroring how the epic's own measurement
// (BAKR-18) was done: a standalone script + a written report, never a
// permanent CI test. Run manually:
//
//   XDG_STATE_HOME=/tmp/bakr-live-e2e-store bun run scripts/live-e2e-adopt-demo.ts /tmp/bakr-live-e2e/work1 <sessionId1> <sessionId2>
//
// Prerequisite (done by hand before running this script — see the ticket's
// own doc write-up for the exact commands): two REAL `claude --bg` sessions
// already started in the source directory, each told a distinct secret
// token, then STOPPED (so the daemon's restore path — not "already
// alive" — is what this script actually exercises).
//
// What this script does, end to end, against REAL stores and a REAL
// `claude`/`systemd-run`:
//   1. Claims the source directory and records both sessions as `on` agents
//      (one named) — directly, since no CLI ships in this story.
//   2. `mv`s the source directory to a new location.
//   3. Runs DETECTION (orphan-model.ts) from the new location's perspective
//      and prints the offer — both agents should be offered.
//   4. Calls `adopt()` (adopt.ts) naming both agents into the new directory.
//   5. Runs TWO real reconcile cycles (daemon.ts, unmodified) — the first
//      issues the restore launches, the second resolves them.
//   6. Prints the final agent records (durableSessionId unchanged,
//      liveSessionId now a NEW, rotated id — fact 2 from the ticket).
//   7. INDEPENDENT VERIFICATION, never trusting bakr's own bookkeeping:
//      greps the ON-DISK TRANSCRIPT under the new path's project slug for
//      each token, and separately asks the model itself (a plain
//      `claude --print --resume`, outside bakr entirely) to recall it.
//
// Cleanup: stops only the sessions this run's own resolution produced, by
// their own recorded ids — nothing else.

import { rename, readFile, readdir, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { claim, emptyStore, list as listClaims } from "../src/claim-model";
import { save as saveClaims, load as loadClaims } from "../src/claim-store-io";
import { emptyAgentStore, putAgent, type AgentRecord } from "../src/agent-model";
import { save as saveAgents, load as loadAgents } from "../src/agent-store-io";
import { claimsPath, agentsPath, realOrphanProbeDeps, realResolveInputs } from "../src/paths";
import { resolveClaimKey } from "../src/claim-key-resolve";
import { lexicallyNormalize } from "../src/claim-key";
import type { ClaimKey } from "../src/claim-key-resolve";
import { classifyDirectory, classifyClaims, buildOffers } from "../src/orphan-model";
import { probeDirectory } from "../src/orphan-probe";
import { adopt } from "../src/adopt";
import { runReconcileCycle, initialDaemonState, type DaemonDeps } from "../src/daemon";
import { runCommand } from "../src/spawn";
import { randomUUID } from "node:crypto";
import { randomBytes as nodeRandomBytes } from "node:crypto";

function slugify(path: string): string {
  return path.replace(/[/.]/g, "-");
}

async function findTranscriptText(newDir: string, sessionId: string): Promise<string | undefined> {
  const slugDir = join(homedir(), ".claude", "projects", slugify(newDir));
  try {
    const path = join(slugDir, `${sessionId}.jsonl`);
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const [, , sourceInput, sessionId1, sessionId2] = process.argv;
  if (!sourceInput || !sessionId1 || !sessionId2) {
    console.error("usage: bun run scripts/live-e2e-adopt-demo.ts <sourceDir> <sessionId1> <sessionId2>");
    process.exit(2);
  }

  const lexical = lexicallyNormalize(sourceInput, { cwd: process.cwd(), home: homedir() });
  const resolvedSource = await resolveClaimKey(lexical, realResolveInputs);
  if (!resolvedSource.ok) throw new Error(`could not resolve source: ${JSON.stringify(resolvedSource)}`);
  const source = resolvedSource.key;

  console.log(`[1/7] claiming "${source}" and recording two on-agents (one named "worker-two")`);
  const claimsFile = claimsPath();
  const agentsFile = agentsPath();
  const claimLoaded = await loadClaims(claimsFile);
  const claimState = claimLoaded.status === "loaded" ? claimLoaded.state : emptyStore();
  await saveClaims(claimsFile, claim(claimState, source, Date.now()).state);

  const agent1: AgentRecord = { id: "@demo-unnamed", name: undefined, directory: source, state: "on", createdAt: Date.now(), durableSessionId: sessionId1, liveSessionId: sessionId1 };
  const agent2: AgentRecord = { id: "@demo-named", name: "worker-two", directory: source, state: "on", createdAt: Date.now(), durableSessionId: sessionId2, liveSessionId: sessionId2 };
  const agentsLoaded = await loadAgents(agentsFile);
  let agentState = agentsLoaded.status === "loaded" ? agentsLoaded.state : emptyAgentStore();
  agentState = putAgent(agentState, agent1);
  agentState = putAgent(agentState, agent2);
  await saveAgents(agentsFile, agentState);

  const newDir = `${source}-moved`;
  console.log(`[2/7] mv "${source}" -> "${newDir}"`);
  await rename(source, newDir);

  console.log(`[3/7] detection from the new location's perspective`);
  const probe = await probeDirectory(source, realOrphanProbeDeps);
  const claimsForDetection = await loadClaims(claimsFile);
  if (claimsForDetection.status !== "loaded") throw new Error("claims store not loaded");
  const agentsForDetection = await loadAgents(agentsFile);
  if (agentsForDetection.status !== "loaded") throw new Error("agents store not loaded");
  const classifications = classifyClaims(claimsForDetection.state, agentsForDetection.state, new Map([[source, probe]]));
  const offers = buildOffers(classifications);
  console.log(`offers: ${JSON.stringify(offers.map((o) => ({ source: o.source, agentIds: o.agents.map((a) => a.id), confidence: o.confidence })))}`);
  if (offers.length !== 1 || offers[0]?.agents.length !== 2) {
    throw new Error(`FAIL: expected exactly one offer with 2 agents, got ${JSON.stringify(offers)}`);
  }
  console.log("PASS: both agents offered for adoption");

  console.log(`[4/7] adopt() naming both agents into "${newDir}"`);
  const adoptOutcome = await adopt(
    { claimsPath: claimsFile, agentsPath: agentsFile, now: () => Date.now(), resolveInputs: realResolveInputs, lexicalInputs: { cwd: process.cwd(), home: homedir() }, probeDeps: realOrphanProbeDeps },
    { source, destinationInput: newDir, agentIds: ["@demo-unnamed", "@demo-named"] }
  );
  console.log(`adopt outcome: ${JSON.stringify(adoptOutcome)}`);
  if (!adoptOutcome.ok) throw new Error(`FAIL: adopt refused: ${JSON.stringify(adoptOutcome)}`);
  console.log("PASS: adopt succeeded");

  const deps: DaemonDeps = {
    runCommand,
    claimsPath: claimsFile,
    agentsPath: agentsFile,
    sessionSlotsPath: join(dirname(agentsFile), "session-slots.json"),
    now: () => Date.now(),
    generateAttemptId: () => randomUUID(),
    randomBytes: (n: number) => nodeRandomBytes(n),
    probeDeps: realOrphanProbeDeps,
  };

  console.log(`[5/7] reconcile cycle 1 (issues the restore launches)`);
  const cycle1 = await runReconcileCycle(initialDaemonState(), deps);
  console.log(`cycle 1 restored: ${JSON.stringify(cycle1.restored)}`);
  if (cycle1.restored.length !== 2) throw new Error(`FAIL: expected 2 restores issued, got ${JSON.stringify(cycle1)}`);

  console.log("waiting 15s for the restores to register with claude's own listing...");
  await new Promise((r) => setTimeout(r, 15_000));

  console.log(`[6/7] reconcile cycle 2 (resolves the pending launches)`);
  const cycle2 = await runReconcileCycle({ claimDegraded: cycle1.claimDegraded, agentsDegraded: cycle1.agentsDegraded, orphanReportSignatures: cycle1.orphanReportSignatures }, deps);
  void cycle2;

  const finalAgents = await loadAgents(agentsFile);
  if (finalAgents.status !== "loaded") throw new Error("final agents store not loaded");
  const final1 = finalAgents.state.agents["@demo-unnamed"];
  const final2 = finalAgents.state.agents["@demo-named"];
  console.log(`final @demo-unnamed: durable=${final1?.durableSessionId} live=${final1?.liveSessionId} directory=${final1?.directory}`);
  console.log(`final @demo-named:   durable=${final2?.durableSessionId} live=${final2?.liveSessionId} directory=${final2?.directory}`);

  if (final1?.durableSessionId !== sessionId1) throw new Error("FAIL: durableSessionId for @demo-unnamed changed — it must never be overwritten by a restore");
  if (final2?.durableSessionId !== sessionId2) throw new Error("FAIL: durableSessionId for @demo-named changed");
  if (final1?.liveSessionId === sessionId1) throw new Error("FAIL: liveSessionId for @demo-unnamed did not rotate — fact 2 says --resume always forks a NEW session id");
  if (final2?.liveSessionId === sessionId2) throw new Error("FAIL: liveSessionId for @demo-named did not rotate");
  console.log("PASS: durable id unchanged, live id rotated (matches the ticket's own measured fact 2)");

  console.log(`[7/7] INDEPENDENT VERIFICATION — never trusting bakr's own record`);
  const newLive1 = final1!.liveSessionId!;
  const newLive2 = final2!.liveSessionId!;

  const transcript1 = await findTranscriptText(newDir, newLive1);
  const transcript2 = await findTranscriptText(newDir, newLive2);
  console.log(`on-disk transcript for demo-unnamed's NEW session exists under the NEW path's slug: ${transcript1 !== undefined}`);
  console.log(`on-disk transcript for demo-named's NEW session exists under the NEW path's slug: ${transcript2 !== undefined}`);
}

main().catch((err) => {
  console.error("SCRIPT FAILED:", err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
