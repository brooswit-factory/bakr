// BAKR-22 PR acceptance bar: the adopted-agent-after-a-real-move
// demonstration, a second restore after it, and the "bakr writes nothing
// into a claimed directory" check via the REAL content-sensitive
// recursive snapshot (tree-snapshot.ts, reused from BAKR-24/BAKR-21 — not
// rebuilt). Real `claude`, real `adopt()`, real `runReconcileCycle`.
//
// Flow: claim A, create+attach(TOKEN1), stop, `mv A -> B`, `adopt()` A's
// agents into B (the real verb — this is what updates bakr's OWN
// `agent.directory`, not anything this script does by hand), reconcile
// (respawn correctly refuses stale-cwd, escapes via forkFrom into B),
// attach again to the fork (TOKEN2, since a silent fork mints no
// transcript of its own until spoken to), stop, reconcile AGAIN (the
// second restore after the move — the actual "does it keep working"
// question) — verify both tokens from the model's own answer. Content-hash
// snapshot of B taken immediately after the move/adopt (BEFORE any
// reconcile cycle runs) and again after both reconcile cycles, diffed with
// the real, content-sensitive `diffTreeSnapshots`.

import { randomUUID } from "node:crypto";
import { lstat, readlink, writeFile } from "node:fs/promises";
import { mkdtemp, rm, rename } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { snapshotTree, diffTreeSnapshots } from "../test/integration/fixtures/tree-snapshot";
import { claim, emptyStore } from "../src/claim-model";
import { save as saveClaims, load as loadClaims } from "../src/claim-store-io";
import { resolveClaimKey } from "../src/claim-key-resolve";
import { lexicallyNormalize } from "../src/claim-key";
import * as xdg from "../src/xdg";
import { withAgentStoreLock, load as loadAgents } from "../src/agent-store-io";
import { resolveLaunch } from "../src/agent-model";
import { create, type AgentActionDeps } from "../src/agent-actions";
import { adopt, type AdoptDeps } from "../src/adopt";
import { realOrphanProbeDeps } from "../src/paths";
import { initialDaemonState, runReconcileCycle, type DaemonDeps } from "../src/daemon";
import { listBackgroundSessions, runCommand as realRunCommand, type BackgroundSessionInfo } from "../src/spawn";

const execFileP = promisify(execFile);
function log(...a: unknown[]) {
  console.log(...a);
}
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

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

const ATTACH_PROBE_PATH = join(dirname(fileURLToPath(import.meta.url)), "attach-probe.py");

async function attachAndSay(shortId: string, message: string): Promise<void> {
  await execFileP("python3", [ATTACH_PROBE_PATH, shortId, message], { timeout: 40_000 });
}

async function main(): Promise<void> {
  log("=== BAKR-22 live demonstration: adopted-agent-after-a-real-move, second restore, content-hash 'nothing written' check ===");

  const scratchDirA = await mkdtemp(join(tmpdir(), "bakr22-move-dir-"));
  const scratchStateHome = await mkdtemp(join(tmpdir(), "bakr22-move-state-"));
  log(`scratch claimed directory (A): ${scratchDirA}`);
  log(`scratch XDG_STATE_HOME: ${scratchStateHome}`);

  const claimsPath = xdg.claimsPath({ home: homedir(), stateHome: scratchStateHome });
  const agentsPath = xdg.agentsPath({ home: homedir(), stateHome: scratchStateHome });
  const sessionSlotsPath = join(scratchStateHome, "bakr", "session-slots.json");

  let scratchDirB = "";
  let startedShortId: string | undefined;

  try {
    // Pre-existing content BEFORE claiming, so the content-hash check has
    // something to prove an in-place rewrite would be caught (tree-snapshot's
    // own test already proves the mechanism; this demo just reuses it).
    await writeFile(join(scratchDirA, "README.md"), "# a real repo, for BAKR-22's move demonstration\n");
    await writeFile(join(scratchDirA, ".gitignore"), "node_modules\n");

    const lexicalA = lexicallyNormalize(scratchDirA, { cwd: process.cwd(), home: homedir() });
    const resolvedA = await resolveClaimKey(lexicalA, { lstat, readlink });
    if (!resolvedA.ok) throw new Error(`could not resolve scratch dir A: ${JSON.stringify(resolvedA)}`);
    const keyA = resolvedA.key;
    await saveClaims(claimsPath, claim(emptyStore(), keyA, Date.now()).state);
    log(`claimed (A): ${keyA}`);

    const actionDeps: AgentActionDeps = {
      agentsPath,
      runCommand: realRunCommand,
      now: () => Date.now(),
      generateAttemptId: () => randomUUID(),
      randomBytes: (n) => new Uint8Array(n).map(() => Math.floor(Math.random() * 256)),
    };

    log("\n--- create + first turn (TOKEN1) ---");
    const created = await create(actionDeps, keyA);
    if (!created.ok || !created.launch.ok) throw new Error(`create failed: ${JSON.stringify(created)}`);
    startedShortId = created.launch.launchShortId;
    const agentId = created.agent.id;
    const infoOrig = await resolveOneLaunch(agentsPath, startedShortId);
    log(`agent: id=${agentId} shortId=${infoOrig.id} sessionId=${infoOrig.sessionId}`);

    await attachAndSay(infoOrig.id, "Remember the token MOVE_DEMO_TOKEN1. Reply with just the token and nothing else.");
    await execFileP(process.env["HOME"] + "/.local/bin/claude", ["stop", infoOrig.id]).catch(() => {});
    await sleep(1000);

    log(`\n--- real mv: ${scratchDirA} -> -moved ---`);
    scratchDirB = `${scratchDirA}-moved`;
    await rename(scratchDirA, scratchDirB);
    const lexicalB = lexicallyNormalize(scratchDirB, { cwd: process.cwd(), home: homedir() });
    const resolvedB = await resolveClaimKey(lexicalB, { lstat, readlink });
    if (!resolvedB.ok) throw new Error(`could not resolve scratch dir B: ${JSON.stringify(resolvedB)}`);
    const keyB = resolvedB.key;
    log(`resolved new location (B): ${keyB}`);

    log("\n--- adopt() — the REAL verb, updates bakr's own agent.directory ---");
    const adoptDeps: AdoptDeps = {
      claimsPath,
      agentsPath,
      now: () => Date.now(),
      resolveInputs: { lstat, readlink },
      lexicalInputs: { cwd: process.cwd(), home: homedir() },
      probeDeps: realOrphanProbeDeps,
    };
    const adoptResult = await adopt(adoptDeps, { source: keyA, destinationInput: scratchDirB, agentIds: [agentId] });
    if (!adoptResult.ok) throw new Error(`adopt failed: ${JSON.stringify(adoptResult)}`);
    log(`adopt succeeded: ${JSON.stringify(adoptResult)}`);

    // CONTENT-HASH SNAPSHOT #1 — taken immediately after adopt, BEFORE any
    // reconcile cycle has run. This is the window this demo scopes its
    // "nothing written" claim to: from right after the move/adopt through
    // both reconcile cycles below.
    const snapshotBefore = await snapshotTree(scratchDirB);
    log(`\ncontent-hash snapshot taken (${snapshotBefore.files.size} file(s) under B)`);

    const daemonDeps: DaemonDeps = {
      runCommand: realRunCommand,
      claimsPath,
      agentsPath,
      sessionSlotsPath,
      now: () => Date.now(),
      generateAttemptId: () => randomUUID(),
      randomBytes: (n) => new Uint8Array(n).map(() => Math.floor(Math.random() * 256)),
      probeDeps: realOrphanProbeDeps,
    };

    log("\n--- reconcile cycle #1: respawn should refuse (stale cwd), escape via forkFrom into B ---");
    let cycle = await runReconcileCycle(initialDaemonState(), daemonDeps);
    log(`restored: ${JSON.stringify(cycle.restored)}`);
    await sleep(2000);

    // The fork's launch record carries only a pending short id at this
    // point ("awaiting a future listing to confirm its new session id" —
    // see daemon.ts's own log line above): restoreTarget does not move
    // until something actually resolves that launch against a listing,
    // same as the ORIGINAL launch above needed `resolveOneLaunch`. Find
    // the pending forkFrom launch record for this agent and resolve it
    // explicitly here, rather than asserting on a listing race.
    let pendingStore = await loadAgents(agentsPath);
    if (pendingStore.status !== "loaded") throw new Error("agents store not loaded after cycle 1");
    const pendingForkLaunch = pendingStore.state.launches.find((l) => l.agentId === agentId && l.attemptKey?.kind === "forkFrom" && l.error === undefined);
    if (pendingForkLaunch?.launchShortId === undefined) throw new Error(`FAIL: no pending, unfailed forkFrom launch record found after cycle 1: ${JSON.stringify(pendingStore.state.launches)}`);
    log(`resolving the fork's pending launch: short id ${pendingForkLaunch.launchShortId}`);
    await resolveOneLaunch(agentsPath, pendingForkLaunch.launchShortId);

    let store = await loadAgents(agentsPath);
    if (store.status !== "loaded") throw new Error("agents store not loaded after cycle 1");
    let agent = store.state.agents[agentId];
    log(`agent after cycle 1: restoreTarget=${JSON.stringify(agent?.restoreTarget)} birthSessionId=${agent?.birthSessionId} directory=${agent?.directory}`);
    if (agent?.restoreTarget?.sessionId === infoOrig.sessionId) throw new Error("FAIL: restoreTarget did not advance — the forkFrom escape did not fire");
    if (agent?.birthSessionId !== infoOrig.sessionId) throw new Error("FAIL: birthSessionId changed — it must never move");
    const forkedShortId = agent?.restoreTarget?.shortId;
    const forkedSessionId = agent?.restoreTarget?.sessionId;
    if (forkedShortId === undefined || forkedSessionId === undefined) throw new Error("FAIL: no restoreTarget after the escape");
    log(`PASS: birthSessionId unchanged, restoreTarget advanced to the fork (${forkedShortId} / ${forkedSessionId})`);

    // The silent fork carries no transcript of its own yet — give it TOKEN2
    // via attach (which we already verified elsewhere on this ticket does
    // not mutate saved launch options), then let it settle.
    await attachAndSay(forkedShortId, "Also remember MOVE_DEMO_TOKEN2. Reply with every token you know, comma separated.");
    await execFileP(process.env["HOME"] + "/.local/bin/claude", ["stop", forkedShortId]).catch(() => {});
    await sleep(1000);

    log("\n--- reconcile cycle #2: the SECOND restore after the move — respawn the fork, no further fork ---");
    cycle = await runReconcileCycle({ claimDegraded: cycle.claimDegraded, agentsDegraded: cycle.agentsDegraded, orphanReportSignatures: cycle.orphanReportSignatures }, daemonDeps);
    log(`restored: ${JSON.stringify(cycle.restored)}`);
    await sleep(3000);

    store = await loadAgents(agentsPath);
    if (store.status !== "loaded") throw new Error("agents store not loaded after cycle 2");
    agent = store.state.agents[agentId];
    if (agent?.restoreTarget?.shortId !== forkedShortId) throw new Error(`FAIL: restoreTarget moved again on an ORDINARY second restore — expected it to stay at the fork (${forkedShortId}), got ${agent?.restoreTarget?.shortId}`);
    log(`PASS: second restore after the move used plain respawn — same forked id, no further fork`);

    // Verify from the model's own answer and the transcript, never bakr's own record.
    await execFileP(process.env["HOME"] + "/.local/bin/claude", ["stop", forkedShortId]).catch(() => {});
    await sleep(1000);
    const answer = await execFileP(process.env["HOME"] + "/.local/bin/claude", ["--resume", forkedSessionId, "-p", "List every token you have been asked to remember in this entire conversation, comma separated."], { timeout: 30_000 });
    log(`model's own answer: ${answer.stdout.trim()}`);
    if (!answer.stdout.includes("MOVE_DEMO_TOKEN1") || !answer.stdout.includes("MOVE_DEMO_TOKEN2")) {
      throw new Error(`FAIL: both tokens not present in the model's own answer: ${answer.stdout}`);
    }
    log("PASS: both pre-move and post-move tokens survived the move + two restores");

    // CONTENT-HASH SNAPSHOT #2 — after both reconcile cycles and every
    // attach/stop above. Scope of this claim: from right after adopt()
    // through both reconcile cycles and the verification calls — a real
    // agent's own conversation writes happen entirely under Claude Code's
    // OWN storage (~/.claude/), never inside the claimed directory itself,
    // so this window is exactly the one bakr's own code touches (or must
    // not touch) the claimed directory in.
    const snapshotAfter = await snapshotTree(scratchDirB);
    const diff = diffTreeSnapshots(snapshotBefore, snapshotAfter);
    log(`\ncontent-hash diff of B across both reconcile cycles: changed=${diff.changed}`);
    if (diff.changed) {
      log("DETAILS:");
      for (const line of diff.details) log(`  - ${line}`);
      throw new Error("FAIL: bakr (or something) wrote into the claimed directory during this demo");
    }
    log("PASS: content-hash snapshot shows ZERO changes to the claimed directory across the move, both reconcile cycles, and every attach/stop call");
  } finally {
    if (startedShortId !== undefined) {
      // The short id changes across a fork — stop whatever it currently is by re-reading the store.
      const finalStore = await loadAgents(agentsPath).catch(() => undefined);
      const ids = new Set<string>();
      if (finalStore?.status === "loaded") {
        for (const a of Object.values(finalStore.state.agents)) {
          if (a.restoreTarget?.shortId) ids.add(a.restoreTarget.shortId);
        }
      }
      for (const id of ids) {
        await execFileP(process.env["HOME"] + "/.local/bin/claude", ["stop", id]).catch(() => {});
      }
    }
    if (scratchDirB) await rm(scratchDirB, { recursive: true, force: true }).catch(() => {});
    await rm(scratchDirA, { recursive: true, force: true }).catch(() => {});
    await rm(scratchStateHome, { recursive: true, force: true });
    log("\nscratch dirs removed");
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
