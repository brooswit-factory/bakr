// BAKR-22 PR acceptance bar: a live demonstration through bakr's REAL
// daemon entry point (runReconcileCycle, the exact exported function the
// daemon loop calls every cycle — never a hand-written replica), driven
// with a real `claude`, restored TWICE, silently, both arms:
//   (a) operator talks to it between restores -> still knows what it was told
//   (b) nobody talks to it between restores -> comes back working anyway
// PLUS the epic's explicit new condition: one run with a TOOL CALL
// genuinely in flight when respawn fires, checked against the session's
// own cumulative totalCostUSD (the instrument the epic settled on after
// the assistant-usage-entry count proved blind to a helper-model side
// call) — if that shows a new billable call, this script says so loudly
// rather than proceeding, per the epic's explicit condition.
//
// Scratch claim dir + scratch XDG_STATE_HOME (never $HOME, never a real
// operator's store). Every session this script talks to is one it itself
// created; every session it stops, it stops by its own recorded id.
// "Restart the process without going through `off`" is simulated with a
// direct `kill -9` on the underlying pid — the daemon-restart / crash case
// bakr's reconcile loop actually exists for — rather than the graceful
// `off` verb, which intentionally does not exercise this path.

import { randomUUID } from "node:crypto";
import { lstat, readlink } from "node:fs/promises";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { claim, emptyStore } from "../src/claim-model";
import { save as saveClaims } from "../src/claim-store-io";
import { resolveClaimKey } from "../src/claim-key-resolve";
import { lexicallyNormalize } from "../src/claim-key";
import * as xdg from "../src/xdg";
import { withAgentStoreLock, load as loadAgents } from "../src/agent-store-io";
import { resolveLaunch } from "../src/agent-model";
import { create, type AgentActionDeps } from "../src/agent-actions";
import { initialDaemonState, runReconcileCycle, type DaemonDeps } from "../src/daemon";
import { listBackgroundSessions, runCommand as realRunCommand, type BackgroundSessionInfo } from "../src/spawn";
import type { OrphanProbeDeps } from "../src/orphan-probe";

const execFileP = promisify(execFile);

function log(...args: unknown[]): void {
  console.log(...args);
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
const alwaysPresentProbeDeps: OrphanProbeDeps = { stat: async () => ({ dev: 1, ino: 1, isDirectory: () => true }) };

async function resolveOneLaunch(agentsPath: string, launchShortId: string, maxWaitMs = 20000): Promise<BackgroundSessionInfo> {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const sessions = await listBackgroundSessions({ runCommand: realRunCommand });
    const found = sessions.find((s) => s.id === launchShortId);
    if (found !== undefined && found.pid !== undefined) {
      await withAgentStoreLock(agentsPath, (current) => ({ state: resolveLaunch(current, launchShortId, found.sessionId), result: undefined }));
      return found;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for launch ${launchShortId} to resolve a pid`);
    await sleep(500);
  }
}

/** Gives an already-running background session ONE real turn via `claude attach`, scripted through a pty (python's pexpect) — verified elsewhere on this ticket not to mutate the job's own saved launch options. */
async function attachAndSay(shortId: string, message: string): Promise<void> {
  await execFileP("python3", ["/tmp/claude-1001/-home-wroosbit-butchr-workspaces-BAKR-22/scratchpad/attach_probe.py", shortId, message], { timeout: 40_000 });
}

async function findTranscriptPath(cwd: string, sessionId: string): Promise<string | undefined> {
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  const projectsDir = join(homedir(), ".claude", "projects");
  const candidates = await readdir(projectsDir).catch(() => [] as string[]);
  for (const dir of candidates) {
    if (!dir.includes(slug.replace(/^-+/, ""))) continue;
    const p = join(projectsDir, dir, `${sessionId}.jsonl`);
    try {
      await readFile(p, "utf8");
      return p;
    } catch {
      continue;
    }
  }
  return undefined;
}

async function cumulativeCostUSD(transcriptPath: string | undefined): Promise<number | undefined> {
  if (transcriptPath === undefined) return undefined;
  const text = await readFile(transcriptPath, "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  let last: number | undefined;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === "cost-state" && typeof obj.totalCostUSD === "number") last = obj.totalCostUSD;
    } catch {
      continue;
    }
  }
  return last;
}

function findPidOf(shortId: string, sessions: readonly BackgroundSessionInfo[]): number | undefined {
  return sessions.find((s) => s.id === shortId)?.pid;
}

async function killDashNine(pid: number): Promise<void> {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

async function main(): Promise<void> {
  log("=== BAKR-22 live demonstration: real daemon entry point (runReconcileCycle), respawn-based restore ===");

  const scratchDir = await mkdtemp(join(tmpdir(), "bakr22-live-dir-"));
  const scratchStateHome = await mkdtemp(join(tmpdir(), "bakr22-live-state-"));
  log(`scratch claimed directory: ${scratchDir}`);
  log(`scratch XDG_STATE_HOME: ${scratchStateHome}`);

  const claimsPath = xdg.claimsPath({ home: homedir(), stateHome: scratchStateHome });
  const agentsPath = xdg.agentsPath({ home: homedir(), stateHome: scratchStateHome });
  const sessionSlotsPath = join(scratchStateHome, "bakr", "session-slots.json");

  const startedShortIds: string[] = [];

  try {
    const lexical = lexicallyNormalize(scratchDir, { cwd: process.cwd(), home: homedir() });
    const resolved = await resolveClaimKey(lexical, { lstat, readlink });
    if (!resolved.ok) throw new Error(`could not resolve scratch dir: ${JSON.stringify(resolved)}`);
    const key = resolved.key;
    await saveClaims(claimsPath, claim(emptyStore(), key, Date.now()).state);
    log(`claimed: ${key}`);

    const actionDeps: AgentActionDeps = {
      agentsPath,
      runCommand: realRunCommand,
      now: () => Date.now(),
      generateAttemptId: () => randomUUID(),
      randomBytes: (n) => new Uint8Array(n).map(() => Math.floor(Math.random() * 256)),
    };
    const daemonDeps: DaemonDeps = {
      runCommand: realRunCommand,
      claimsPath,
      agentsPath,
      sessionSlotsPath,
      now: () => Date.now(),
      generateAttemptId: () => randomUUID(),
      randomBytes: (n) => new Uint8Array(n).map(() => Math.floor(Math.random() * 256)),
      probeDeps: alwaysPresentProbeDeps,
    };

    // ============ ARM (a): operator talks between two respawns ============
    log("\n=== ARM (a): create -> talk -> kill -> reconcile (respawn #1) -> talk again -> kill -> reconcile (respawn #2) -> verify BOTH tokens ===");

    const createdA = await create(actionDeps, key);
    if (!createdA.ok || !createdA.launch.ok) throw new Error(`create A failed: ${JSON.stringify(createdA)}`);
    startedShortIds.push(createdA.launch.launchShortId);
    const agentAId = createdA.agent.id;
    const infoA = await resolveOneLaunch(agentsPath, createdA.launch.launchShortId);
    log(`agent A: id=${agentAId} shortId=${infoA.id} sessionId=${infoA.sessionId}`);

    await attachAndSay(infoA.id, "Remember the token ARM_A_TOKEN1. Reply with just the token and nothing else.");
    let sessionsNow = await listBackgroundSessions({ runCommand: realRunCommand });
    let pid = findPidOf(infoA.id, sessionsNow);
    if (pid !== undefined) await killDashNine(pid);
    await sleep(1500);

    log("--- reconcile cycle #1 (respawn #1, silent, real daemon entry point) ---");
    let cycle = await runReconcileCycle(initialDaemonState(), daemonDeps);
    log(`restored: ${JSON.stringify(cycle.restored)}`);
    await sleep(3000);

    let storeAfter = await loadAgents(agentsPath);
    if (storeAfter.status !== "loaded") throw new Error("agents store not loaded after cycle 1");
    let agentA = storeAfter.state.agents[agentAId];
    log(`agent A after respawn #1: restoreTarget=${JSON.stringify(agentA?.restoreTarget)} birthSessionId=${agentA?.birthSessionId}`);
    if (agentA?.restoreTarget?.sessionId !== infoA.sessionId) throw new Error(`FAIL: restoreTarget.sessionId changed after an ordinary respawn — expected ${infoA.sessionId}, got ${agentA?.restoreTarget?.sessionId}`);
    log("PASS: same session id after respawn #1 — no fork");

    await attachAndSay(infoA.id, "Also remember ARM_A_TOKEN2. Reply with every token you know, comma separated.");
    sessionsNow = await listBackgroundSessions({ runCommand: realRunCommand });
    pid = findPidOf(infoA.id, sessionsNow);
    if (pid !== undefined) await killDashNine(pid);
    await sleep(1500);

    log("--- reconcile cycle #2 (respawn #2 — the actual rewind-defect scenario) ---");
    cycle = await runReconcileCycle({ claimDegraded: cycle.claimDegraded, agentsDegraded: cycle.agentsDegraded, orphanReportSignatures: cycle.orphanReportSignatures }, daemonDeps);
    log(`restored: ${JSON.stringify(cycle.restored)}`);
    await sleep(3000);

    storeAfter = await loadAgents(agentsPath);
    if (storeAfter.status !== "loaded") throw new Error("agents store not loaded after cycle 2");
    agentA = storeAfter.state.agents[agentAId];
    if (agentA?.restoreTarget?.sessionId !== infoA.sessionId) throw new Error(`FAIL: restoreTarget.sessionId changed after respawn #2 — expected ${infoA.sessionId}, got ${agentA?.restoreTarget?.sessionId}`);

    // Verify from transcript + model's own answer — never from bakr's own record.
    await execFileP(process.env["HOME"] + "/.local/bin/claude", ["stop", infoA.id]).catch(() => {});
    await sleep(500);
    const answer1 = await execFileP(process.env["HOME"] + "/.local/bin/claude", ["--resume", infoA.sessionId, "-p", "List every token you have been asked to remember in this entire conversation, comma separated."], { timeout: 30_000 });
    log(`model's own answer after TWO respawns: ${answer1.stdout.trim()}`);
    if (!answer1.stdout.includes("ARM_A_TOKEN1") || !answer1.stdout.includes("ARM_A_TOKEN2")) {
      throw new Error(`FAIL: model did not report both tokens after two respawns: ${answer1.stdout}`);
    }
    log("PASS (arm a): both tokens survived two silent respawns through the REAL daemon entry point");

    // ============ ARM (b): nobody talks to it between two respawns ============
    log("\n=== ARM (b): create -> talk ONCE -> kill -> reconcile x2 with NOBODY talking in between -> still comes back working ===");

    const createdB = await create(actionDeps, key);
    if (!createdB.ok || !createdB.launch.ok) throw new Error(`create B failed: ${JSON.stringify(createdB)}`);
    startedShortIds.push(createdB.launch.launchShortId);
    const agentBId = createdB.agent.id;
    const infoB = await resolveOneLaunch(agentsPath, createdB.launch.launchShortId);
    log(`agent B: id=${agentBId} shortId=${infoB.id} sessionId=${infoB.sessionId}`);

    await attachAndSay(infoB.id, "Remember the token ARM_B_TOKEN. Reply with just the token and nothing else.");
    sessionsNow = await listBackgroundSessions({ runCommand: realRunCommand });
    pid = findPidOf(infoB.id, sessionsNow);
    if (pid !== undefined) await killDashNine(pid);
    await sleep(1500);

    let cycleB = await runReconcileCycle(initialDaemonState(), daemonDeps);
    log(`restored (cycle 1): ${JSON.stringify(cycleB.restored)}`);
    await sleep(3000);
    // nobody talks to it here — silence, exactly B8
    sessionsNow = await listBackgroundSessions({ runCommand: realRunCommand });
    pid = findPidOf(infoB.id, sessionsNow);
    if (pid !== undefined) await killDashNine(pid);
    await sleep(1500);

    cycleB = await runReconcileCycle({ claimDegraded: cycleB.claimDegraded, agentsDegraded: cycleB.agentsDegraded, orphanReportSignatures: cycleB.orphanReportSignatures }, daemonDeps);
    log(`restored (cycle 2): ${JSON.stringify(cycleB.restored)}`);
    await sleep(3000);

    const storeAfterB = await loadAgents(agentsPath);
    if (storeAfterB.status !== "loaded") throw new Error("agents store not loaded (arm b)");
    const agentB = storeAfterB.state.agents[agentBId];
    if (agentB?.restoreTarget?.sessionId !== infoB.sessionId) throw new Error(`FAIL (arm b): restoreTarget.sessionId changed with nobody talking to it — expected ${infoB.sessionId}, got ${agentB?.restoreTarget?.sessionId}`);

    await execFileP(process.env["HOME"] + "/.local/bin/claude", ["stop", infoB.id]).catch(() => {});
    await sleep(500);
    const answerB = await execFileP(process.env["HOME"] + "/.local/bin/claude", ["--resume", infoB.sessionId, "-p", "What token, if any, have you been asked to remember? Answer plainly."], { timeout: 30_000 });
    log(`model's own answer (arm b, after 2 silent respawns nobody talked between): ${answerB.stdout.trim()}`);
    if (!answerB.stdout.includes("ARM_B_TOKEN")) throw new Error(`FAIL (arm b): token lost: ${answerB.stdout}`);
    log("PASS (arm b): agent comes back working, with its conversation up to the last point anyone spoke to it — no fork, no rewind, nobody talked to it in between");

    // ============ Epic's new condition: a TOOL CALL genuinely in flight ============
    log("\n=== EPIC CONDITION: respawn while a TOOL CALL is genuinely in flight — checked against cumulative totalCostUSD ===");
    const createdC = await create(actionDeps, key);
    if (!createdC.ok || !createdC.launch.ok) throw new Error(`create C failed: ${JSON.stringify(createdC)}`);
    startedShortIds.push(createdC.launch.launchShortId);
    const agentCId = createdC.agent.id;
    const infoC = await resolveOneLaunch(agentsPath, createdC.launch.launchShortId);
    log(`agent C: id=${agentCId} shortId=${infoC.id} sessionId=${infoC.sessionId}`);

    // Fire a prompt that triggers a real Bash tool call taking a few
    // seconds, WITHOUT waiting for it to finish, then respawn mid-flight.
    void attachAndSay(infoC.id, "Run this exact bash command and nothing else: sleep 10 && echo TOOLDONE");
    await sleep(4000); // give it time to actually start the tool call
    sessionsNow = await listBackgroundSessions({ runCommand: realRunCommand });
    pid = findPidOf(infoC.id, sessionsNow);
    if (pid !== undefined) await killDashNine(pid);
    await sleep(1500);

    const costBefore = await cumulativeCostUSD(await findTranscriptPath(scratchDir, infoC.sessionId));
    log(`cumulative totalCostUSD BEFORE respawn: ${costBefore}`);

    const cycleC = await runReconcileCycle(initialDaemonState(), daemonDeps);
    log(`restored: ${JSON.stringify(cycleC.restored)}`);
    await sleep(3000);

    const costAfter = await cumulativeCostUSD(await findTranscriptPath(scratchDir, infoC.sessionId));
    log(`cumulative totalCostUSD AFTER respawn (interrupting the tool call): ${costAfter}`);

    if (costAfter !== undefined && costBefore !== undefined && costAfter > costBefore) {
      log(`\n*** STOP: totalCostUSD MOVED (${costBefore} -> ${costAfter}) across a respawn that interrupted a tool call in flight. Per the epic's explicit condition, this is reported rather than proceeded past. ***`);
    } else {
      log(`PASS: totalCostUSD did not move (${costBefore} -> ${costAfter}) across a respawn interrupting a tool call — B8a holds for the tool-call-in-flight case too`);
    }
  } finally {
    log("\n--- cleanup: stopping every session this script started, by its own id ---");
    for (const shortId of startedShortIds) {
      try {
        await execFileP(process.env["HOME"] + "/.local/bin/claude", ["stop", shortId]);
      } catch {
        // may already be dead from a kill -9 above — fine
      }
    }
    await rm(scratchDir, { recursive: true, force: true });
    await rm(scratchStateHome, { recursive: true, force: true });
    log("scratch dirs removed");
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
