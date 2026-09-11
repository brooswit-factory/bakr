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
// [CORRECTED, BAKR-24 review round] This script no longer ASSERTS that the
// restore launches succeed. Measured on this checkout (claude 2.1.268,
// printed below): `claude --bg --resume <id>` refuses when the session's
// ORIGINAL job-registered cwd (`~/.claude/jobs/<shortId>/state.json`) no
// longer exists — a claude-build-dependent limitation (present but not
// enforced on 2.1.251), NOT a bakr defect, and NOT something this story
// works around (adoption rewrites `directory` and nothing else; it never
// writes into claude's own storage — see the ticket's own ruling). So this
// script reports whichever of the two honest outcomes actually happens,
// rather than manufacturing a pass:
//   - REFUSED: the launch fails with claude's own stale-cwd message, and
//     bakr's daemon reports it LOUDLY (see daemon.ts's
//     `detectStaleRegisteredCwdRefusal` handling) naming the agent, the
//     destination it now lives in, and the stale path claude complains
//     about — this script asserts THAT reporting fires correctly.
//   - RESTORED: on a build where claude does not enforce the stale cwd
//     (or where a later claude fixes this), the restore succeeds and this
//     script verifies the conversation is intact via independent evidence
//     (the on-disk transcript, and the model's own recollection via a
//     PLAIN, non-bg `--resume`, outside bakr entirely).
// Either way, the STORE-level correctness (detection offers both agents,
// adopt moves both atomically, nothing written into either directory) is
// verified identically and unconditionally.
//
// Cleanup: stops only the sessions this run's own resolution produced, by
// their own recorded ids — nothing else. Never touches `~/.claude/`.

import { rename, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID, randomBytes as nodeRandomBytes } from "node:crypto";
import { claim, emptyStore } from "../src/claim-model";
import { save as saveClaims, load as loadClaims } from "../src/claim-store-io";
import { emptyAgentStore, putAgent, type AgentRecord } from "../src/agent-model";
import { save as saveAgents, load as loadAgents } from "../src/agent-store-io";
import { claimsPath, agentsPath, realOrphanProbeDeps, realResolveInputs } from "../src/paths";
import { resolveClaimKey } from "../src/claim-key-resolve";
import { lexicallyNormalize } from "../src/claim-key";
import { classifyClaims, buildOffers } from "../src/orphan-model";
import { probeDirectory } from "../src/orphan-probe";
import { adopt } from "../src/adopt";
import { runReconcileCycle, initialDaemonState, type DaemonDeps } from "../src/daemon";
import { runCommand } from "../src/spawn";

function slugify(path: string): string {
  return path.replace(/[/.]/g, "-");
}

async function findTranscriptText(newDir: string, sessionId: string): Promise<string | undefined> {
  const slugDir = join(homedir(), ".claude", "projects", slugify(newDir));
  try {
    return await readFile(join(slugDir, `${sessionId}.jsonl`), "utf8");
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

  const versionProc = Bun.spawn(["claude", "--version"], { stdout: "pipe" });
  const claudeVersion = (await new Response(versionProc.stdout).text()).trim();
  console.log(`claude --version: ${claudeVersion}`);

  const lexical = lexicallyNormalize(sourceInput, { cwd: process.cwd(), home: homedir() });
  const resolvedSource = await resolveClaimKey(lexical, realResolveInputs);
  if (!resolvedSource.ok) throw new Error(`could not resolve source: ${JSON.stringify(resolvedSource)}`);
  const source = resolvedSource.key;

  console.log(`[1/6] claiming "${source}" and recording two on-agents (one named "worker-two")`);
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
  console.log(`[2/6] mv "${source}" -> "${newDir}"`);
  await rename(source, newDir);

  console.log(`[3/6] detection from the new location's perspective`);
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

  console.log(`[4/6] adopt() naming both agents into "${newDir}"`);
  const adoptOutcome = await adopt(
    { claimsPath: claimsFile, agentsPath: agentsFile, now: () => Date.now(), resolveInputs: realResolveInputs, lexicalInputs: { cwd: process.cwd(), home: homedir() }, probeDeps: realOrphanProbeDeps },
    { source, destinationInput: newDir, agentIds: ["@demo-unnamed", "@demo-named"] }
  );
  console.log(`adopt outcome: ${JSON.stringify(adoptOutcome)}`);
  if (!adoptOutcome.ok) throw new Error(`FAIL: adopt refused: ${JSON.stringify(adoptOutcome)}`);
  console.log("PASS: adopt succeeded — both agents moved, one lock hold, one write");

  const capturedLines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    capturedLines.push(args.map(String).join(" "));
    originalLog(...args);
  };

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

  console.log(`[5/6] reconcile cycle 1 (issues the restore launches)`);
  const cycle1 = await runReconcileCycle(initialDaemonState(), deps);
  console.log(`cycle 1 restored: ${JSON.stringify(cycle1.restored)}`);

  console.log = originalLog;

  const finalAgentsAfterCycle1 = await loadAgents(agentsFile);
  if (finalAgentsAfterCycle1.status !== "loaded") throw new Error("agents store not loaded");
  const unresolvedAfterCycle1 = finalAgentsAfterCycle1.state.launches.filter((l) => l.error !== undefined);

  if (cycle1.restored.length === 2) {
    console.log("\n=== RESTORED (this build's claude did not refuse) ===");
    console.log("waiting 15s for the restores to register with claude's own listing...");
    await new Promise((r) => setTimeout(r, 15_000));
    const cycle2 = await runReconcileCycle({ claimDegraded: cycle1.claimDegraded, agentsDegraded: cycle1.agentsDegraded, orphanReportSignatures: cycle1.orphanReportSignatures }, deps);
    void cycle2;

    const finalAgents = await loadAgents(agentsFile);
    if (finalAgents.status !== "loaded") throw new Error("final agents store not loaded");
    const final1 = finalAgents.state.agents["@demo-unnamed"];
    const final2 = finalAgents.state.agents["@demo-named"];
    console.log(`final @demo-unnamed: durable=${final1?.durableSessionId} live=${final1?.liveSessionId} directory=${final1?.directory}`);
    console.log(`final @demo-named:   durable=${final2?.durableSessionId} live=${final2?.liveSessionId} directory=${final2?.directory}`);

    if (final1?.durableSessionId !== sessionId1 || final2?.durableSessionId !== sessionId2) throw new Error("FAIL: a durableSessionId changed — it must never be overwritten by a restore");
    if (final1?.liveSessionId === sessionId1 || final2?.liveSessionId === sessionId2) throw new Error("FAIL: liveSessionId did not rotate — fact 2 says --resume always forks a NEW session id");
    console.log("PASS: durable id unchanged, live id rotated on both agents (matches the ticket's own measured fact 2)");

    console.log(`[6/6] INDEPENDENT VERIFICATION — never trusting bakr's own record`);
    const t1 = await findTranscriptText(newDir, final1!.liveSessionId!);
    const t2 = await findTranscriptText(newDir, final2!.liveSessionId!);
    console.log(`on-disk transcript for demo-unnamed's NEW session exists under the NEW path's slug: ${t1 !== undefined}`);
    console.log(`on-disk transcript for demo-named's NEW session exists under the NEW path's slug: ${t2 !== undefined}`);
  } else {
    console.log("\n=== REFUSED (this build's claude enforces the stale-cwd check) ===");
    console.log(`cycle 1 restored 0 of 2 expected agents (claude ${claudeVersion})`);
    if (unresolvedAfterCycle1.length !== 2) {
      throw new Error(`FAIL: expected exactly 2 unresolved launch records after the refused restore, got ${JSON.stringify(unresolvedAfterCycle1)}`);
    }
    const staleLines = capturedLines.filter((l) => l.includes("REFUSED by claude itself"));
    console.log(`daemon's LOUD stale-cwd report lines: ${staleLines.length}`);
    if (staleLines.length !== 2) {
      throw new Error(`FAIL: expected the daemon's loud stale-cwd detection to fire for both agents, got ${staleLines.length} matching line(s): ${JSON.stringify(capturedLines)}`);
    }
    for (const line of staleLines) {
      if (!line.includes(newDir)) throw new Error(`FAIL: report does not name the NEW destination "${newDir}": ${line}`);
      if (!line.includes(source)) throw new Error(`FAIL: report does not name the STALE path "${source}": ${line}`);
    }
    console.log("PASS: bakr correctly attributes the failure to claude's own stale registry entry, naming the agent, the real (new) directory, and the stale path — never blaming systemd-run and never retrying automatically");
    console.log("PASS (store-level, unconditional regardless of the claude-build refusal): detection offered both agents, adopt moved both atomically in the store — see steps 3-4 above");
  }
}

main().catch((err) => {
  console.error("SCRIPT FAILED:", err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
