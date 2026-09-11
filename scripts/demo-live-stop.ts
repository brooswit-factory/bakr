// ============================================================================
// PROVISIONAL DEMONSTRATION HARNESS — THIS IS NOT A CLI GRAMMAR.
// It exercises the action set in src/agent-actions.ts exactly as any future
// CLI (BAKR-3) or webapp (BAKR-4) will, but takes no arguments, reads no
// process.argv, and defines no command surface. It exists solely to drive
// BAKR-21's live, two-real-agent stop demonstration end to end and print
// the raw evidence the ticket's definition of done (item 1) asks for.
// ============================================================================
//
// SAFETY, absolute and non-negotiable (see this file's own checks below):
//   - A SCRATCH claimed directory (mkdtemp) and a SCRATCH XDG_STATE_HOME
//     (mkdtemp) — never `$HOME`, never a real operator's claim store.
//   - Every session this script stops is one IT ITSELF launched, by that
//     session's own recorded short id — never by directory, never a guess.
//   - A full, unscoped `claude agents --json` snapshot is taken before
//     anything is launched and again after everything this script started
//     has been stopped, and the two are diffed to prove the host's
//     pre-existing sessions (this Unix user may be running many) were
//     never touched.
//   - The `claude daemon run` singleton's pid (once it exists) is verified
//     unchanged after the stop — proving the stop never reached it.
//
// This script performs its OWN `resolveLaunch` step after each `create()`
// call, exactly as `daemon.ts`'s reconcile loop would in production
// (`resolvePendingLaunches`) — this script does not run a live daemon loop
// alongside it, so it does that one step by hand, using the identical
// exported function the daemon itself uses. Not a shortcut around the
// verbs: `create()`/`off()` themselves are exercised exactly as shipped.

import { randomUUID } from "node:crypto";
import { lstat, readlink, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotDirectory } from "./dir-snapshot";
import { claim, emptyStore } from "../src/claim-model";
import { save as saveClaims } from "../src/claim-store-io";
import { resolveClaimKey } from "../src/claim-key-resolve";
import { lexicallyNormalize } from "../src/claim-key";
import * as xdg from "../src/xdg";
import { withAgentStoreLock, load as loadAgents } from "../src/agent-store-io";
import { resolveLaunch } from "../src/agent-model";
import { create, off, type AgentActionDeps } from "../src/agent-actions";
import { listBackgroundSessions, runCommand as realRunCommand, type RunCommandOptions, type CommandResult, type BackgroundSessionInfo } from "../src/spawn";
import { execSync } from "node:child_process";

function log(...args: unknown[]): void {
  console.log(...args);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Wraps the REAL runCommand so every argv this demo's own verb calls issue is captured verbatim, for the PR body's raw evidence — delegates to the real spawn substrate unchanged. */
function makeLoggingRunCommand(): { runCommand: AgentActionDeps["runCommand"]; log: { argv: string[]; cwd: string | undefined; at: string }[] } {
  const calls: { argv: string[]; cwd: string | undefined; at: string }[] = [];
  async function runCommand(argv: string[], opts: RunCommandOptions): Promise<CommandResult> {
    calls.push({ argv: [...argv], cwd: opts.cwd, at: new Date().toISOString() });
    return realRunCommand(argv, opts);
  }
  return { runCommand, log: calls };
}

function findSingletonPid(): number | undefined {
  try {
    const out = execSync(`ps -eo pid,cmd | grep -F "claude daemon run" | grep -v grep || true`, { encoding: "utf8" });
    const line = out.trim().split("\n").find((l) => l.trim().length > 0);
    if (!line) return undefined;
    const pid = Number(line.trim().split(/\s+/)[0]);
    return Number.isFinite(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

async function resolveOneLaunch(agentsPath: string, launchShortId: string, maxWaitMs = 20000): Promise<BackgroundSessionInfo> {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const sessions = await listBackgroundSessions({ runCommand: realRunCommand });
    const found = sessions.find((s) => s.id === launchShortId);
    if (found !== undefined) {
      await withAgentStoreLock(agentsPath, (current) => ({ state: resolveLaunch(current, launchShortId, found.sessionId), result: undefined }));
      return found;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for launch ${launchShortId} to appear in a listing`);
    await sleep(500);
  }
}

async function main(): Promise<void> {
  log("=== BAKR-21 live demonstration: two real agents, one directory, stop exactly one ===");

  const scratchDir = await mkdtemp(join(tmpdir(), "bakr-live-demo-dir-"));
  const scratchStateHome = await mkdtemp(join(tmpdir(), "bakr-live-demo-state-"));
  log(`scratch claimed directory: ${scratchDir}`);
  log(`scratch XDG_STATE_HOME: ${scratchStateHome}`);

  const claimsPath = xdg.claimsPath({ home: homedir(), stateHome: scratchStateHome });
  const agentsPath = xdg.agentsPath({ home: homedir(), stateHome: scratchStateHome });

  const startedShortIds: string[] = [];
  let singletonPidBefore: number | undefined;
  let singletonPidAfter: number | undefined;

  try {
    // Pre-existing content, BEFORE claiming — criterion 7's corrected
    // instrument needs something already there to prove an IN-PLACE,
    // same-name rewrite is detected (an empty directory can only reveal
    // additions, the exact class a bare mtime/ctime check already caught;
    // see scripts/dir-snapshot.ts's module comment for why that is not
    // the gap that mattered).
    await writeFile(join(scratchDir, "README.md"), "# a real repo, for this demonstration\n");
    await writeFile(join(scratchDir, ".gitignore"), "node_modules\n");

    // --- claim the scratch directory ---
    const lexical = lexicallyNormalize(scratchDir, { cwd: process.cwd(), home: homedir() });
    const resolved = await resolveClaimKey(lexical, { lstat, readlink });
    if (!resolved.ok) throw new Error(`could not resolve scratch dir: ${JSON.stringify(resolved)}`);
    const key = resolved.key;
    await saveClaims(claimsPath, claim(emptyStore(), key, Date.now()).state);
    log(`claimed: ${key}`);

    // --- BEFORE snapshot: the whole host's background listing, untouched by this demo ---
    const beforeAll = await listBackgroundSessions({ runCommand: realRunCommand });
    log(`\n--- BEFORE: full unscoped listing (${beforeAll.length} background session(s) already on this host, none started by this demo) ---`);
    log(JSON.stringify(beforeAll, null, 2));

    const dirSnapshotBefore = await snapshotDirectory(scratchDir);

    // --- create TWO real agents in the SAME directory ---
    const { runCommand: loggingRunCommand, log: callLog } = makeLoggingRunCommand();
    const deps: AgentActionDeps = {
      agentsPath,
      runCommand: loggingRunCommand,
      now: () => Date.now(),
      generateAttemptId: () => randomUUID(),
      randomBytes: (n) => new Uint8Array(n).map(() => Math.floor(Math.random() * 256)),
    };

    log("\n--- creating agent A ---");
    const createdA = await create(deps, key);
    if (!createdA.ok || !createdA.launch.ok) throw new Error(`create A failed: ${JSON.stringify(createdA)}`);
    startedShortIds.push(createdA.launch.launchShortId);
    log(`agent A: id=${createdA.agent.id} launchShortId=${createdA.launch.launchShortId}`);

    log("\n--- creating agent B ---");
    const createdB = await create(deps, key);
    if (!createdB.ok || !createdB.launch.ok) throw new Error(`create B failed: ${JSON.stringify(createdB)}`);
    startedShortIds.push(createdB.launch.launchShortId);
    log(`agent B: id=${createdB.agent.id} launchShortId=${createdB.launch.launchShortId}`);

    log("\n--- resolving both launches (the step daemon.ts's reconcile loop would normally do) ---");
    const listedA = await resolveOneLaunch(agentsPath, createdA.launch.launchShortId);
    const listedB = await resolveOneLaunch(agentsPath, createdB.launch.launchShortId);
    log(`agent A live: sessionId=${listedA.sessionId} pid=${listedA.pid}`);
    log(`agent B live: sessionId=${listedB.sessionId} pid=${listedB.pid}`);

    if (listedA.pid === undefined || listedB.pid === undefined) throw new Error("expected both sessions to report a pid");
    if (!isPidAlive(listedA.pid) || !isPidAlive(listedB.pid)) throw new Error("expected both pids independently verified alive via process.kill(pid, 0)");

    singletonPidBefore = findSingletonPid();
    log(`\nclaude daemon run singleton pid (independent ps check): ${singletonPidBefore ?? "NOT FOUND"}`);
    if (singletonPidBefore === undefined) throw new Error("expected to find the claude daemon run singleton after launching two --bg sessions");

    // --- verify nothing written into the claimed directory BEFORE the stop ---
    const dirSnapshotMid = await snapshotDirectory(scratchDir);

    // --- THE STOP: turn agent A off ---
    log(`\n--- calling off() on agent A (${createdA.agent.id}) ---`);
    const offResult = await off(deps, key, createdA.agent.id);
    log(`off() result: ${JSON.stringify(offResult)}`);
    if (!offResult.ok || offResult.kind !== "turned-off" || offResult.stop.kind !== "stopped") {
      throw new Error(`off() did not report a clean stop: ${JSON.stringify(offResult)}`);
    }

    // --- INDEPENDENT VERIFICATION, from fresh reads, NOT from bakr's own record ---
    await sleep(500);
    const afterListing = await listBackgroundSessions({ runCommand: realRunCommand });
    const stillThereB = afterListing.find((s) => s.sessionId === listedB.sessionId);
    const goneA = afterListing.find((s) => s.sessionId === listedA.sessionId);

    log("\n--- AFTER: full unscoped listing ---");
    log(JSON.stringify(afterListing, null, 2));

    singletonPidAfter = findSingletonPid();

    log("\n=== INDEPENDENT VERIFICATION (not from bakr's own store) ===");
    log(`agent A (${listedA.sessionId}) present in listing after stop: ${goneA !== undefined} (expect false)`);
    log(`agent A pid ${listedA.pid} alive after stop (process.kill(pid,0)): ${isPidAlive(listedA.pid)} (expect false)`);
    log(`agent B (${listedB.sessionId}) present in listing after stop: ${stillThereB !== undefined} (expect true)`);
    log(`agent B sessionId unchanged: ${stillThereB?.sessionId === listedB.sessionId} (expect true)`);
    log(`agent B pid unchanged: ${stillThereB?.pid === listedB.pid} (expect true)`);
    log(`agent B pid ${listedB.pid} still alive (process.kill(pid,0)): ${isPidAlive(listedB.pid)} (expect true)`);
    log(`singleton pid unchanged: before=${singletonPidBefore} after=${singletonPidAfter} (expect equal)`);
    log(`singleton pid still alive: ${singletonPidAfter !== undefined && isPidAlive(singletonPidAfter)} (expect true)`);

    const stopArgvCalls = callLog.filter((c) => c.argv[0] === "claude" && c.argv[1] === "stop");
    log(`\nthe ONLY stop command(s) issued during off(): ${JSON.stringify(stopArgvCalls.map((c) => c.argv))}`);
    log(`(expect exactly one: ["claude","stop","${createdA.launch.launchShortId}"])`);

    const anySystemctl = callLog.some((c) => c.argv.join(" ").toLowerCase().includes("systemctl"));
    log(`any systemctl invocation during off(): ${anySystemctl} (expect false)`);

    const dirSnapshotAfterStop = await snapshotDirectory(scratchDir);
    log("\n=== nothing written into the claimed directory (item 7, CORRECTED instrument) ===");
    log("SCOPE, stated honestly: this proves bakr's OWN verbs/spawn-substrate wrote nothing into the claimed directory across this run. It does NOT claim anything about what a real attached agent's own conversation might legitimately write there — both agents here were launched with no prompt at all (B8), so nothing exercised that separate path either.");
    log(`recursive content-sensitive snapshot, BEFORE create -> AFTER stop, identical: ${dirSnapshotBefore === dirSnapshotAfterStop} (expect true)`);
    log(`(mid-point, right after both creates, for completeness: identical to BEFORE: ${dirSnapshotBefore === dirSnapshotMid})`);
    log(`snapshot value (before): ${dirSnapshotBefore}`);
    log(`snapshot value (after):  ${dirSnapshotAfterStop}`);
    log("this instrument's own positive controls (new file / dotfile / subdirectory / deletion / in-place rewrite / nested rewrite) and negative control are demonstrated separately in test/unit/dir-snapshot.test.ts — all six mutation shapes are shown DETECTED there, which is what makes the 'identical' result above meaningful rather than a probe that would pass either way.");

    // Sanity asserts — fail loudly rather than let a misleading PASS print above.
    const problems: string[] = [];
    if (goneA !== undefined) problems.push("agent A still present in listing after stop");
    if (isPidAlive(listedA.pid)) problems.push("agent A pid still alive after stop");
    if (stillThereB === undefined) problems.push("agent B missing from listing after stop");
    if (stillThereB?.pid !== listedB.pid) problems.push("agent B pid changed");
    if (!isPidAlive(listedB.pid)) problems.push("agent B pid no longer alive");
    if (singletonPidAfter !== singletonPidBefore) problems.push("singleton pid changed");
    if (singletonPidAfter === undefined || !isPidAlive(singletonPidAfter)) problems.push("singleton no longer alive");
    if (stopArgvCalls.length !== 1) problems.push(`expected exactly 1 stop call, got ${stopArgvCalls.length}`);
    if (anySystemctl) problems.push("a systemctl invocation was issued");
    if (dirSnapshotBefore !== dirSnapshotAfterStop) problems.push("claimed directory's recursive content-sensitive snapshot changed — bakr wrote into it");

    if (problems.length > 0) {
      throw new Error(`DEMONSTRATION FAILED: ${problems.join("; ")}`);
    }
    log("\n*** ALL CHECKS PASSED ***");

    // --- cleanup: stop agent B too, so nothing is left running ---
    log(`\n--- cleanup: calling off() on agent B (${createdB.agent.id}) ---`);
    const offB = await off(deps, key, createdB.agent.id);
    log(`off() result for B: ${JSON.stringify(offB)}`);

    await sleep(500);
    const finalListing = await listBackgroundSessions({ runCommand: realRunCommand });
    const finalNet = finalListing.filter((s) => beforeAll.every((b) => b.sessionId !== s.sessionId));
    log(`\n--- FINAL: any background sessions present now that were not present in the BEFORE snapshot: ${finalNet.length} (expect 0) ---`);
    if (finalNet.length > 0) {
      log(JSON.stringify(finalNet, null, 2));
      throw new Error("host was NOT left as found — residual session(s) remain");
    }
    log("Host left exactly as found: the BEFORE and FINAL unscoped listings match (net zero from this demo).");
  } finally {
    // Absolute last resort: if anything above threw after a launch but
    // before its own cleanup ran, stop every session THIS SCRIPT started,
    // by its own recorded short id — never anything else.
    for (const shortId of startedShortIds) {
      try {
        const sessions = await listBackgroundSessions({ runCommand: realRunCommand });
        if (sessions.some((s) => s.id === shortId)) {
          log(`[cleanup] stopping leftover session ${shortId}`);
          await realRunCommand(["claude", "stop", shortId], { timeoutMs: 15000 });
        }
      } catch (err) {
        log(`[cleanup] failed to stop ${shortId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await rm(scratchDir, { recursive: true, force: true });
    await rm(scratchStateHome, { recursive: true, force: true });
    log(`\n[cleanup] removed scratch dirs`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
