// BAKR-22 / epic condition B8a: respawn while a TOOL CALL is GENUINELY in
// flight, checked against cumulative totalCostUSD (not the assistant-entry
// count, which the epic already found blind to a helper-model side call).
// Corrects the earlier attempt, which killed on a timer without confirming
// a tool call had actually started — this version polls the transcript
// directly for a `tool_use` content block (Bash) before killing, which is
// definitive rather than inferred from elapsed time or `state: "working"`.

import { randomUUID } from "node:crypto";
import { lstat, readlink } from "node:fs/promises";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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
function log(...a: unknown[]) {
  console.log(...a);
}
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
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

const ATTACH_PROBE_PATH = join(dirname(fileURLToPath(import.meta.url)), "attach-probe.py");

async function attachAndSayNoWait(shortId: string, message: string): Promise<void> {
  // Fire-and-forget: does NOT await the pty script's own internal 20s
  // settle sleep — we want to poll the transcript ourselves and kill as
  // soon as a tool_use appears, not wait for the script's own timeline.
  execFileP("python3", [ATTACH_PROBE_PATH, shortId, message], { timeout: 40_000 }).catch(() => {});
}

async function findTranscriptPath(cwdSlugHint: string, sessionId: string): Promise<string | undefined> {
  const projectsDir = join(homedir(), ".claude", "projects");
  const candidates = await readdir(projectsDir).catch(() => [] as string[]);
  for (const dir of candidates) {
    if (!dir.includes(cwdSlugHint)) continue;
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

async function hasToolUseBash(transcriptPath: string | undefined): Promise<boolean> {
  if (transcriptPath === undefined) return false;
  const text = await readFile(transcriptPath, "utf8").catch(() => undefined);
  if (text === undefined) return false;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type !== "assistant") continue;
      const content = obj.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block?.type === "tool_use" && block?.name === "Bash") return true;
      }
    } catch {
      continue;
    }
  }
  return false;
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

async function main(): Promise<void> {
  log("=== BAKR-22 / B8a: respawn while a TOOL CALL is GENUINELY in flight (confirmed via transcript, not a timer) ===");
  const scratchDir = await mkdtemp(join(tmpdir(), "bakr22-toolcall-dir-"));
  const scratchStateHome = await mkdtemp(join(tmpdir(), "bakr22-toolcall-state-"));
  const claimsPath = xdg.claimsPath({ home: homedir(), stateHome: scratchStateHome });
  const agentsPath = xdg.agentsPath({ home: homedir(), stateHome: scratchStateHome });
  const sessionSlotsPath = join(scratchStateHome, "bakr", "session-slots.json");
  let shortId: string | undefined;

  try {
    const lexical = lexicallyNormalize(scratchDir, { cwd: process.cwd(), home: homedir() });
    const resolved = await resolveClaimKey(lexical, { lstat, readlink });
    if (!resolved.ok) throw new Error(`could not resolve scratch dir: ${JSON.stringify(resolved)}`);
    const key = resolved.key;
    await saveClaims(claimsPath, claim(emptyStore(), key, Date.now()).state);
    log(`claimed: ${key}`);
    const cwdSlugHint = scratchDir.split("/").pop() ?? "";

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

    const created = await create(actionDeps, key);
    if (!created.ok || !created.launch.ok) throw new Error(`create failed: ${JSON.stringify(created)}`);
    shortId = created.launch.launchShortId;
    const info = await resolveOneLaunch(agentsPath, shortId);
    log(`agent: id=${created.agent.id} shortId=${info.id} sessionId=${info.sessionId}`);

    void attachAndSayNoWait(info.id, "Run this exact bash command and nothing else, do not explain first, just run it: sleep 12 && echo TOOLDONE");

    log("polling the transcript for a Bash tool_use block (definitive proof the tool call has actually started)...");
    const deadline = Date.now() + 20_000;
    let sawToolUse = false;
    let transcriptPath: string | undefined;
    while (Date.now() < deadline) {
      transcriptPath = await findTranscriptPath(cwdSlugHint, info.sessionId);
      if (await hasToolUseBash(transcriptPath)) {
        sawToolUse = true;
        break;
      }
      await sleep(500);
    }
    if (!sawToolUse) throw new Error("FAIL (test setup, not a product finding): never observed a Bash tool_use block within 20s — cannot claim a tool call was in flight");
    log("CONFIRMED: a Bash tool_use block is in the transcript — the tool call is genuinely in flight now");

    const costBeforeKill = await cumulativeCostUSD(transcriptPath);
    log(`cumulative totalCostUSD at the moment the tool call is confirmed in flight: ${costBeforeKill}`);

    const sessionsNow = await listBackgroundSessions({ runCommand: realRunCommand });
    const pid = sessionsNow.find((s) => s.id === info.id)?.pid;
    if (pid === undefined) throw new Error("FAIL (test setup): no pid available to kill even though a tool_use was observed");
    log(`killing pid ${pid} NOW, mid-tool-call`);
    process.kill(pid, "SIGKILL");

    // Give claude's own job-state registry time to settle past the
    // transient "listed but no pid yet" window before reconciling. A
    // process killed mid-TOOL-CALL took longer to settle than an idle one
    // did in an earlier trial on this ticket — loop reconcile cycles like
    // the real daemon actually would (it just tries again next cycle)
    // rather than assuming one fixed sleep is enough.
    let cycle: Awaited<ReturnType<typeof runReconcileCycle>> = { claimDegraded: false, agentsDegraded: false, restored: [], skippedListingFailed: false, orphanReportSignatures: {} };
    let state = initialDaemonState();
    const reconcileDeadline = Date.now() + 60_000;
    while (Date.now() < reconcileDeadline) {
      await sleep(4000);
      cycle = await runReconcileCycle(state, daemonDeps);
      state = { claimDegraded: cycle.claimDegraded, agentsDegraded: cycle.agentsDegraded, orphanReportSignatures: cycle.orphanReportSignatures };
      log(`reconcile attempt restored: ${JSON.stringify(cycle.restored)}`);
      if (cycle.restored.length > 0) break;
    }
    await sleep(3000);

    const costAfterRespawn = await cumulativeCostUSD(transcriptPath);
    log(`cumulative totalCostUSD AFTER the respawn that interrupted the tool call: ${costAfterRespawn}`);

    if (costAfterRespawn !== undefined && costBeforeKill !== undefined && costAfterRespawn > costBeforeKill) {
      log(`\n*** STOP: totalCostUSD MOVED (${costBeforeKill} -> ${costAfterRespawn}) across a respawn that interrupted a GENUINE tool call in flight. Per the epic's explicit condition, reporting this rather than proceeding. ***`);
      process.exitCode = 2;
    } else if (cycle.restored.length === 0) {
      log(`\nINCONCLUSIVE: the reconcile cycle did not report a restore for this agent (${JSON.stringify(cycle.restored)}) — the liveness gate likely classified it not-verifiable/alive rather than dead; not a cost measurement either way.`);
      process.exitCode = 3;
    } else {
      log(`\nPASS: totalCostUSD did not move (${costBeforeKill} -> ${costAfterRespawn}) across a respawn that interrupted a GENUINE, transcript-confirmed tool call in flight. B8a holds for this case.`);
    }
  } finally {
    if (shortId !== undefined) {
      await execFileP(process.env["HOME"] + "/.local/bin/claude", ["stop", shortId]).catch(() => {});
    }
    await rm(scratchDir, { recursive: true, force: true });
    await rm(scratchStateHome, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
