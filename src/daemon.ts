// The daemon's own reconcile cycle and loop (BAKR-19, implementing story
// BAKR-16). Rewired from session-slots.ts onto the agent store
// (agent-model.ts / agent-store-io.ts / agent-store-migrate.ts) as the
// single source of truth for lifecycle and membership (B1). Wires together
// the claim store (BAKR-6, read-only from here — nothing in this file ever
// claims or releases a directory) and the spawn substrate (BAKR-7).
//
// B7: this loop restores only `on` agents and stays spawn-only — there is
// NO action anywhere in this file that means "stop". An `off` or `archived`
// agent is never launched. A live session this loop did not expect is never
// touched.
//
// R-F (B12): every mutation of the agent store goes through
// `withAgentStoreLock` (agent-store-io.ts), which re-reads fresh state
// INSIDE the lock before applying a change — this file never threads a
// single top-of-cycle snapshot through multiple later saves the way the old
// session-slots-based cycle did. AMENDED (R-F.3): for every per-agent
// decision that leads to a write (begin a launch, reset a retry count, give
// up), the DECISION itself — not only the write — is re-derived from that
// same fresh, lock-held read. An outer, unlocked read is used only to
// enumerate WHICH agent ids to consider this cycle and for logging; it is
// never trusted for the actual mutation, which always re-checks against the
// freshest state at the moment it commits.

import { load as loadClaims } from "./claim-store-io";
import { list as listClaims, emptyStore, type ClaimStoreState } from "./claim-model";
import { loadOrMigrateAgentStore } from "./agent-store-migrate";
import { load as loadAgents, withAgentStoreLock } from "./agent-store-io";
import {
  type AgentStoreState,
  type AttemptKey,
  emptyAgentStore,
  agentsInDirectory,
  beginLaunch,
  markLaunchStarted,
  markLaunchFailed,
  resolveLaunch,
  resolveRespawnAttempt,
  resolvePendingCreation,
  mintUniqueAgentId,
  pendingLaunches,
  unresolvedLaunches,
  isSupersededStaleCwdRespawnFailure,
  hasLaunchRecordFor,
  promoteUnresolvableLaunches,
  restoreAttemptCount,
  recordRestoreAttempt,
  resetRestoreAttempts,
  planRestore,
} from "./agent-model";
import { listBackgroundSessions, decideLiveness, checkLiveness, isPidAlive, launch, respawnSession, isRecognizedStaleCwdRefusal, detectStaleRegisteredCwdRefusal, type RunCommand, type BackgroundSessionInfo } from "./spawn";
import { probeResumableTranscript, type TranscriptProbeDeps } from "./transcript-probe";
import { realTranscriptProbeDeps } from "./paths";
import type { ClaimKey } from "./claim-key-resolve";
import { classifyDirectory, type OrphanVerdict } from "./orphan-model";
import { probeDirectory, type OrphanProbeDeps } from "./orphan-probe";
import { log } from "./log";

/** See session-slots.ts's own module comment for the live incident this bound closes — ported unchanged. Now counted per AGENT id (R-C), not per durable session id. */
const MAX_CONSECUTIVE_UNVERIFIED_RESTORES = 3;

export interface DaemonDeps {
  readonly runCommand: RunCommand;
  readonly claimsPath: string;
  readonly agentsPath: string;
  readonly sessionSlotsPath: string;
  readonly now: () => number;
  readonly generateAttemptId: () => string;
  readonly randomBytes: (byteLength: number) => Uint8Array;
  /** BAKR-24 Q1/Q4: real `stat`, injected for the same reason every other filesystem seam in this tree is — unit-testable with fakes. See orphan-probe.ts / paths.ts's `realOrphanProbeDeps`. */
  readonly probeDeps: OrphanProbeDeps;
  /** BAKR-22: read-only access to Claude Code's own `~/.claude/projects/` tree, for the never-spoken-to-then-moved check. Optional — defaults to the real filesystem (`realTranscriptProbeDeps`, paths.ts). */
  readonly transcriptProbeDeps?: TranscriptProbeDeps;
  readonly acquireTimeoutMs?: number;
}

export interface DaemonState {
  readonly claimDegraded: boolean;
  /** Covers BOTH a malformed `agents.json` and a malformed `session-slots.json` discovered while `agents.json` was still absent (R-A.1) — either way, this run never writes the agent store again. */
  readonly agentsDegraded: boolean;
  /**
   * BAKR-24 Q4: one signature per claimed directory CURRENTLY classified
   * `gone`/`unavailable` AND holding at least one `on` agent — `"<status>:<sorted on-agent ids>"`.
   * Carried cycle-to-cycle so the orphan report below logs only on a
   * CHANGE (a directory going orphaned, its verdict flipping between
   * `gone`/`unavailable`, or its set of `on` agents changing) rather than
   * once per cycle forever — the same "must not loop on it" requirement
   * Q4 states explicitly for launching, applied here to logging. A
   * directory that resolves again (or loses its last `on` agent) is simply
   * absent from this map on the next cycle — nothing needs an explicit
   * "cleared" transition logged; the next time it orphans, it is a fresh
   * signature and reports again.
   */
  readonly orphanReportSignatures: Readonly<Record<string, string>>;
}

export function initialDaemonState(): DaemonState {
  return { claimDegraded: false, agentsDegraded: false, orphanReportSignatures: {} };
}

function lockOpts(deps: DaemonDeps): { acquireTimeoutMs?: number } {
  const opts: { acquireTimeoutMs?: number } = {};
  if (deps.acquireTimeoutMs !== undefined) opts.acquireTimeoutMs = deps.acquireTimeoutMs;
  return opts;
}

interface LoadedForCycle {
  readonly claimState: ClaimStoreState;
  readonly agentState: AgentStoreState;
  readonly claimDegraded: boolean;
  readonly agentsDegraded: boolean;
  readonly agentsDegradedError?: string;
}

/**
 * Loads the claim store (read-only, unchanged discipline) and the agent
 * store — via `loadOrMigrateAgentStore`, which itself implements R-A.1 (a
 * malformed `agents.json` is never treated as absent, and never falls back
 * to reading `session-slots.json`) and the one-time, lock-protected
 * migration (R-A). Constraint 3: `missing` is a success; `malformed`
 * degrades for the rest of this process's life.
 */
async function loadStores(deps: DaemonDeps): Promise<LoadedForCycle> {
  const claimResult = await loadClaims(deps.claimsPath);
  let claimState: ClaimStoreState;
  let claimDegraded = false;
  if (claimResult.status === "malformed") {
    claimDegraded = true;
    claimState = emptyStore();
    log("error", `claim store at "${deps.claimsPath}" is malformed: ${claimResult.error} — starting/continuing degraded: restoring nothing, never writing to this file for the life of this process (BAKR-8 Constraint 3)`);
  } else if (claimResult.status === "missing") {
    claimState = emptyStore();
  } else {
    claimState = claimResult.state;
  }

  const agentsOutcome = await loadOrMigrateAgentStore({
    agentsPath: deps.agentsPath,
    sessionSlotsPath: deps.sessionSlotsPath,
    now: deps.now,
    randomBytes: deps.randomBytes,
  });

  if (agentsOutcome.status === "malformed") {
    log(
      "error",
      `agent store degraded: ${agentsOutcome.source === "agents" ? `"${deps.agentsPath}"` : `"${deps.sessionSlotsPath}" (read while migrating — "${deps.agentsPath}" was genuinely absent)`} is malformed: ${agentsOutcome.error} — starting/continuing degraded: restoring nothing, never writing to "${deps.agentsPath}" for the life of this process (BAKR-19 R-A.1 / BAKR-8 Constraint 3). ${agentsOutcome.source === "session-slots" ? "A malformed agents.json is NEVER treated as absent, so this path is only reachable when agents.json itself was genuinely missing — session-slots.json is never read as a fallback for a malformed agents.json." : ""}`
    );
    return { claimState, agentState: emptyAgentStore(), claimDegraded, agentsDegraded: true, agentsDegradedError: agentsOutcome.error };
  }

  if (agentsOutcome.status === "migrated") {
    log(
      "info",
      `migrated ${agentsOutcome.summary.agentsCreated} agent(s) from "${deps.sessionSlotsPath}" into "${deps.agentsPath}" across ${agentsOutcome.summary.directories.length} director${agentsOutcome.summary.directories.length === 1 ? "y" : "ies"}: ${JSON.stringify(agentsOutcome.summary.directories)}. This is a one-time migration — a later load reads "${deps.agentsPath}" directly and mints nothing further.`
    );
  }

  return { claimState, agentState: agentsOutcome.state, claimDegraded, agentsDegraded: false };
}

export interface ReconcileResult {
  readonly claimDegraded: boolean;
  readonly agentsDegraded: boolean;
  /** `sessionId` is the durable id being resumed for a restore, or `undefined` for a fresh launch (no prior session) — see AC4/AC2. `key` is reported as an ATTRIBUTE only, never used to identify the agent (B2). */
  readonly restored: readonly { readonly agentId: string; readonly key: ClaimKey; readonly sessionId: string | undefined }[];
  readonly skippedListingFailed: boolean;
  /** See `DaemonState.orphanReportSignatures` — carried forward into the next cycle's `DaemonState` by `runDaemonLoop`. */
  readonly orphanReportSignatures: Readonly<Record<string, string>>;
}

/** Promotes any launch record left wedged by a crash mid-`launch()` in a PRIOR run — see agent-model.ts's own `promoteUnresolvableLaunches` doc, ported unchanged in spirit, rekeyed to agent id. One locked mutation; a no-op save is skipped. */
async function promoteWedgedLaunches(deps: DaemonDeps): Promise<{ malformed: boolean; error?: string }> {
  const result = await withAgentStoreLock(
    deps.agentsPath,
    (current) => {
      const wedged = current.launches.filter((l) => l.launchShortId === undefined && l.error === undefined);
      if (wedged.length === 0) {
        return { state: current, result: [] as typeof wedged };
      }
      const next = promoteUnresolvableLaunches(
        current,
        "the daemon process ended before this launch's outcome was recorded (crashed, or was killed, mid-launch) — cannot distinguish never-detached from detached-then-the-wrapper-failed (BAKR-8 Constraint 2)"
      );
      return { state: next, result: wedged };
    },
    lockOpts(deps)
  );
  if (result.status === "malformed") return { malformed: true, error: result.error };
  for (const record of result.result) {
    log(
      "error",
      `recovered an unresolvable launch record for agent ${record.agentId} in "${record.key}" (attempt ${record.attemptId}, ${new Date(record.attemptedAt).toISOString()}) left by a prior run that ended mid-launch — marked permanently unresolved, never retried automatically (BAKR-8 Constraint 2)`
    );
  }
  return { malformed: false };
}

/**
 * Resolves any pending launches (fresh or restore) whose short id appears in
 * THIS cycle's listing — one locked mutation, using the listing already
 * fetched this cycle rather than issuing a second one. Also resolves
 * migration-recovered `pendingCreations` (R-C.3 case 3) the identical way,
 * except a match there MINTS a brand-new agent rather than updating an
 * existing one — see `resolvePendingCreation`'s own doc for why that is the
 * one place in this store a resolution creates an agent as a side effect.
 */
async function resolvePendingLaunches(deps: DaemonDeps, sessions: readonly BackgroundSessionInfo[]): Promise<{ malformed: boolean; error?: string }> {
  const result = await withAgentStoreLock(
    deps.agentsPath,
    (current) => {
      let next = current;
      const resolvedInfo: { attemptId: string; agentId: string; key: ClaimKey; launchShortId: string; sessionId: string; attemptKey: AttemptKey | undefined }[] = [];
      for (const pending of pendingLaunches(next)) {
        if (pending.launchShortId === undefined) continue;
        // `respawn` attempts resolve synchronously (see `dispatchRespawn`'s
        // daemon-side counterpart below) and never leave a PENDING record
        // waiting for a listing — only `fresh` and `forkFrom` do, since
        // both go through `launch()`, which only ever returns a short id
        // immediately. A `respawn`-kind attemptKey should never reach here;
        // skip it defensively rather than mis-resolving it.
        if (pending.attemptKey?.kind === "respawn") continue;
        const found = sessions.find((s) => s.id === pending.launchShortId);
        if (found === undefined) continue;
        next = resolveLaunch(next, pending.launchShortId, found.sessionId);
        resolvedInfo.push({ attemptId: pending.attemptId, agentId: pending.agentId, key: pending.key, launchShortId: pending.launchShortId, sessionId: found.sessionId, attemptKey: pending.attemptKey });
      }

      const createdInfo: { attemptId: string; key: ClaimKey; launchShortId: string; sessionId: string; agentId: string }[] = [];
      for (const pendingCreation of next.pendingCreations) {
        const found = sessions.find((s) => s.id === pendingCreation.launchShortId);
        if (found === undefined) continue;
        const beforeIds = new Set(Object.keys(next.agents));
        next = resolvePendingCreation(next, pendingCreation.launchShortId, found.sessionId, () => mintUniqueAgentId(next, deps.randomBytes), deps.now());
        const newId = Object.keys(next.agents).find((id) => !beforeIds.has(id));
        if (newId !== undefined) {
          createdInfo.push({ attemptId: pendingCreation.attemptId, key: pendingCreation.key, launchShortId: pendingCreation.launchShortId, sessionId: found.sessionId, agentId: newId });
        }
      }

      return { state: next, result: { resolvedInfo, createdInfo } };
    },
    lockOpts(deps)
  );
  if (result.status === "malformed") return { malformed: true, error: result.error };
  for (const info of result.result.resolvedInfo) {
    log(
      "info",
      `resolved launch attempt ${info.attemptId} for agent ${info.agentId} in "${info.key}": short id ${info.launchShortId} -> session ${info.sessionId}${info.attemptKey?.kind === "forkFrom" ? ` (forkFrom escape from stale-cwd session ${info.attemptKey.sessionId} — restoreTarget advances to this new session; birthSessionId untouched)` : " (fresh launch — birthSessionId/restoreTarget both set for the first time)"}`
    );
  }
  for (const info of result.result.createdInfo) {
    log(
      "info",
      `R-C.3 case 3: migration-recovered pending creation (attempt ${info.attemptId}) in "${info.key}" resolved: short id ${info.launchShortId} -> minted NEW unnamed agent ${info.agentId} holding session ${info.sessionId}`
    );
  }
  return { malformed: false };
}

export type AgentDecision =
  | { readonly kind: "skip" }
  | { readonly kind: "reset" }
  | { readonly kind: "alive" }
  | { readonly kind: "not-verifiable"; readonly reason: string }
  | { readonly kind: "give-up"; readonly attemptsSoFar: number; readonly shortId: string }
  | { readonly kind: "begin-fresh-launch"; readonly attemptId: string }
  | { readonly kind: "begin-respawn"; readonly attemptId: string; readonly shortId: string; readonly restoreSessionId: string };

/**
 * ONE agent's reconcile decision AND its write, made inside a SINGLE lock
 * hold (AMENDED R-F.3 / AC15) — this is what closes the "decided X is on,
 * an operator turns it off before beginLaunch runs" race a lock around the
 * write alone cannot close. Never holds the lock across `launch()` (R-F):
 * that call happens afterward, unlocked, and its outcome is recorded in a
 * SECOND, separate locked mutation.
 *
 * EXPORTED (review, PR #13): AC14's two-process demonstration
 * (test/integration/agent-decide-race.test.ts) calls this function
 * directly rather than a hand-written replica of its discipline, so the
 * test binds to the actual shipped decision boundary and regresses if a
 * future edit ever moves the read outside the lock.
 */
export async function decideAndBeginForAgent(deps: DaemonDeps, agentId: string, key: ClaimKey, sessions: readonly BackgroundSessionInfo[]): Promise<{ malformed: boolean; error?: string; decision?: AgentDecision }> {
  const result = await withAgentStoreLock<AgentDecision>(
    deps.agentsPath,
    (current) => {
      const agent = current.agents[agentId];
      if (agent === undefined || agent.state !== "on") {
        return { state: current, result: { kind: "skip" } };
      }

      const plan = planRestore(agent);
      if (plan.kind === "fresh") {
        if (hasLaunchRecordFor(current, agentId, undefined)) {
          return { state: current, result: { kind: "skip" } };
        }
        const attemptId = deps.generateAttemptId();
        const next = beginLaunch(current, agentId, key, undefined, attemptId, deps.now());
        return { state: next, result: { kind: "begin-fresh-launch", attemptId } };
      }

      const shortId = plan.shortId;
      const attemptKey: AttemptKey = { kind: "respawn", shortId };
      if (hasLaunchRecordFor(current, agentId, attemptKey)) {
        return { state: current, result: { kind: "skip" } };
      }

      // BAKR-22: liveness is checked against the SHORT id now (what
      // `respawn` itself keys on — `checkLiveness`'s own convention),
      // never the full session id `--bg --resume` used to key against.
      // `respawn` kills and restarts a live process (measured) — this gate
      // is what keeps the daemon from calling it on `alive` or
      // `not-verifiable`. THERE IS NO "dead" VERDICT (`decideLiveness`
      // produces exactly `alive | not-verifiable | absent`, and
      // `checkLiveness` can additionally produce `listing-failed` — see
      // liveness.ts). Respawn/forkFrom are reachable ONLY on `absent`;
      // `listing-failed` NEVER proceeds, which is the whole point of
      // splitting it out of the old `unknown`. `absent` means the listing
      // SUCCEEDED and this session was not in it — its own doc comment is
      // explicit that this is "not proof of death" —
      // merely absence from this cycle's listing. That is the SAME weak
      // link the old `--bg --resume` path already restored on; BAKR-22
      // does not strengthen it, only renames the mechanism that acts on
      // it. Do not read "the gate" as a death-verification gate — it is a
      // never-alive, never-uncertain gate, which is the honest strength
      // this design actually has.
      const entry = sessions.find((s) => s.id === shortId);
      const pidVerifiedAlive = entry?.pid !== undefined ? isPidAlive(entry.pid) : false;
      const verdict = decideLiveness(shortId, entry, pidVerifiedAlive);

      if (verdict.status === "alive") {
        if (restoreAttemptCount(current, agentId) > 0) {
          return { state: resetRestoreAttempts(current, agentId), result: { kind: "reset" } };
        }
        return { state: current, result: { kind: "alive" } };
      }
      if (verdict.status === "not-verifiable") {
        return { state: current, result: { kind: "not-verifiable", reason: verdict.reason } };
      }

      const attemptsSoFar = restoreAttemptCount(current, agentId);
      if (attemptsSoFar >= MAX_CONSECUTIVE_UNVERIFIED_RESTORES) {
        const giveUpAttemptId = deps.generateAttemptId();
        let next = beginLaunch(current, agentId, key, attemptKey, giveUpAttemptId, deps.now());
        next = markLaunchFailed(
          next,
          giveUpAttemptId,
          `gave up after ${attemptsSoFar} consecutive restore attempts for this agent, none independently verified alive — likely a silently-failing resume (ticket measurement 5); never retried automatically (BAKR-8 Constraint 2)`
        );
        return { state: next, result: { kind: "give-up", attemptsSoFar, shortId } };
      }

      const attemptId = deps.generateAttemptId();
      let next = beginLaunch(current, agentId, key, attemptKey, attemptId, deps.now());
      next = recordRestoreAttempt(next, agentId);
      return { state: next, result: { kind: "begin-respawn", attemptId, shortId, restoreSessionId: agent.restoreTarget?.sessionId ?? shortId } };
    },
    lockOpts(deps)
  );

  if (result.status === "malformed") return { malformed: true, error: result.error };
  return { malformed: false, decision: result.result };
}

/** Records `launch()`'s outcome — a SECOND, separate locked mutation, never sharing a lock hold with `launch()` itself (R-F: never hold the lock across launch()). */
async function recordLaunchOutcome(deps: DaemonDeps, attemptId: string, outcome: { ok: true; id: string } | { ok: false; error: string }): Promise<void> {
  await withAgentStoreLock(
    deps.agentsPath,
    (current) => ({
      state: outcome.ok ? markLaunchStarted(current, attemptId, outcome.id) : markLaunchFailed(current, attemptId, outcome.error),
      result: undefined,
    }),
    lockOpts(deps)
  );
}

/**
 * `abandonedSessionId`, when present on `"forked"`, means the escape found
 * NO transcript to carry (positive evidence, per `probeResumableTranscript`)
 * and chose a bare fresh launch instead of a doomed fork — the reconcile
 * loop's own log line names this explicitly (see the dispatch site below)
 * rather than letting it read like an ordinary successful fork.
 */
export type RespawnDispatchResult =
  | { readonly kind: "respawned" }
  | { readonly kind: "forked"; readonly newShortId: string | undefined; readonly abandonedSessionId?: string }
  | { readonly kind: "refused"; readonly error: string };

/**
 * Dispatches ONE `respawn` attempt, unlocked (R-F: never hold the lock
 * across a spawn), and records the outcome in a second, separate locked
 * mutation — mirrors `agent-actions.ts`'s own `dispatchRespawn` for the
 * `on` verb exactly; this is the daemon's reconcile-loop counterpart.
 *
 * THE TOCTOU RE-CHECK (epic-flagged risk 2): the liveness verdict that
 * chose to reach this function was decided INSIDE a lock hold that has
 * since been released (B12 forbids holding it across the spawn below).
 * `respawn` silently kills and restarts whatever process currently holds
 * `shortId` — if an operator attached in the gap between that decision and
 * this call, their fresh session would be killed by a restore that had
 * already decided (correctly, at the time) that nothing was there. Re-
 * verifying liveness here, immediately before the spawn and with nothing
 * else in between, narrows that window from "up to one reconcile interval"
 * to "the gap between two back-to-back listing calls" — it does NOT close
 * the race (an attach in that remaining sub-second gap is still possible),
 * and this comment says so rather than claiming a fix B12 does not allow.
 *
 * THE ONE RECOGNISED FAILURE SHAPE that transitions to `forkFrom`:
 * `isRecognizedStaleCwdRefusal`. ANY OTHER non-zero result is a typed
 * refusal that leaves the original `respawn` attempt failed and NEVER
 * falls through to a fork — forking on an unrecognised failure would
 * abandon a live conversation and mint a new one on a guess.
 */
async function dispatchRespawnForDaemon(deps: DaemonDeps, agentId: string, key: ClaimKey, attemptId: string, shortId: string, restoreSessionId: string): Promise<RespawnDispatchResult> {
  // BAKR-22 CORRECTION: this re-check now goes through the real
  // `checkLiveness` (spawn/liveness.ts), whose verdict distinguishes
  // `absent` (the listing succeeded, genuinely not found) from
  // `listing-failed` (the listing call itself threw) — a distinction the
  // epic caught missing here: the ORIGINAL version of this re-check
  // treated a THROWN listing the same as "not alive" and proceeded to
  // respawn anyway, which is exactly the unannounced-stop-hidden-in-
  // restore case B7 forbids, caused by a transient CLI hiccup rather than
  // any fact about the session. `absent` is the ONLY verdict that proceeds
  // — `alive`, `not-verifiable`, AND `listing-failed` all refuse.
  const recheck = await checkLiveness(shortId, { runCommand: deps.runCommand });
  if (recheck.status !== "absent") {
    const reason = recheck.status === "alive" ? `verified alive with pid ${recheck.pid}` : recheck.reason;
    const error = `respawn refused: TOCTOU re-check reported "${recheck.status}" for session ${shortId} (${reason}) — only "absent" (a listing that succeeded and genuinely did not find it) proceeds; an operator likely attached since the decision was made, or the re-check listing itself failed, so this is not killed`;
    await withAgentStoreLock(deps.agentsPath, (current) => ({ state: markLaunchFailed(current, attemptId, error), result: undefined }), lockOpts(deps));
    return { kind: "refused", error };
  }

  const result = await respawnSession(shortId, { runCommand: deps.runCommand });
  if (result.ok) {
    await withAgentStoreLock(deps.agentsPath, (current) => ({ state: resolveRespawnAttempt(current, attemptId), result: undefined }), lockOpts(deps));
    return { kind: "respawned" };
  }

  if (isRecognizedStaleCwdRefusal(result.error)) {
    // BAKR-22 EPIC CORRECTION: routes on `probeResumableTranscript`'s
    // THREE outcomes, never a boolean — a false "no transcript" would make
    // bakr choose `fresh` and PERMANENTLY, SILENTLY abandon a real
    // conversation, worse than the phantom-fork failure this mechanism
    // exists to avoid (the phantom fails LOUDLY on first prompt instead).
    // `could-not-tell` proceeds with NEITHER escape — no new launch
    // attempt at all, only the original failure recorded, leaving the
    // agent wedged for an operator to resolve via `on`/`adopt`.
    const probe = await probeResumableTranscript(restoreSessionId, deps.transcriptProbeDeps ?? realTranscriptProbeDeps);
    if (probe.status === "could-not-tell") {
      const error = `could not determine whether session ${restoreSessionId} has a resumable transcript (${probe.reason}) — refusing rather than guessing in either direction; resolve with on/adopt once the layout question is settled`;
      await withAgentStoreLock(deps.agentsPath, (current) => ({ state: markLaunchFailed(current, attemptId, result.error), result: undefined }), lockOpts(deps));
      return { kind: "refused", error };
    }
    const canForkFrom = probe.status === "has-transcript";
    const forkResult = canForkFrom ? await launch(key, ["--resume", restoreSessionId, "--fork-session"], { runCommand: deps.runCommand }) : await launch(key, [], { runCommand: deps.runCommand });
    await withAgentStoreLock(
      deps.agentsPath,
      (current) => {
        let next = markLaunchFailed(current, attemptId, result.error);
        const forkAttemptId = deps.generateAttemptId();
        const forkKey: AttemptKey = { kind: "forkFrom", sessionId: restoreSessionId };
        next = beginLaunch(next, agentId, key, forkKey, forkAttemptId, deps.now());
        next = forkResult.ok ? markLaunchStarted(next, forkAttemptId, forkResult.id) : markLaunchFailed(next, forkAttemptId, forkResult.error);
        return { state: next, result: undefined };
      },
      lockOpts(deps)
    );
    const newShortId = forkResult.ok ? forkResult.id : undefined;
    return canForkFrom ? { kind: "forked", newShortId } : { kind: "forked", newShortId, abandonedSessionId: restoreSessionId };
  }

  await withAgentStoreLock(deps.agentsPath, (current) => ({ state: markLaunchFailed(current, attemptId, result.error), result: undefined }), lockOpts(deps));
  return { kind: "refused", error: result.error };
}

/**
 * One reconcile cycle. See the module comment for the R-F.3 discipline this
 * function's per-agent helper enforces. Exactly ONE `claude agents --json`
 * listing per cycle. A listing failure makes the WHOLE cycle a no-op with a
 * loud log (BAKR-8 Constraint 1). Only `on` agents are ever considered for
 * launch (B7) — an `off` or `archived` agent is never touched, and there is
 * no code path in this file that stops anything.
 */
export async function runReconcileCycle(prior: DaemonState, deps: DaemonDeps): Promise<ReconcileResult> {
  if (prior.claimDegraded || prior.agentsDegraded) {
    const parts: string[] = [];
    if (prior.claimDegraded) parts.push(`claim store "${deps.claimsPath}" is malformed`);
    if (prior.agentsDegraded) parts.push(`agent store at "${deps.agentsPath}" (or its pre-migration session-slots.json) is malformed`);
    log("error", `reconcile skipped this cycle: ${parts.join("; ")} — this process will never write to the affected file(s); restart after repairing on disk`);
    return { claimDegraded: prior.claimDegraded, agentsDegraded: prior.agentsDegraded, restored: [], skippedListingFailed: false, orphanReportSignatures: prior.orphanReportSignatures };
  }

  const { claimState, claimDegraded, agentsDegraded } = await loadStores(deps);
  if (claimDegraded || agentsDegraded) {
    return { claimDegraded, agentsDegraded, restored: [], skippedListingFailed: false, orphanReportSignatures: prior.orphanReportSignatures };
  }

  const promoted = await promoteWedgedLaunches(deps);
  if (promoted.malformed) {
    return { claimDegraded: false, agentsDegraded: true, restored: [], skippedListingFailed: false, orphanReportSignatures: prior.orphanReportSignatures };
  }

  let sessions: BackgroundSessionInfo[];
  try {
    sessions = await listBackgroundSessions({ runCommand: deps.runCommand });
  } catch (err) {
    log(
      "error",
      `reconcile skipped this cycle: \`claude agents --json\` listing failed: ${err instanceof Error ? err.message : String(err)} — never treated as "nothing running"; no restore is issued this cycle (BAKR-8 Constraint 1)`
    );
    return { claimDegraded: false, agentsDegraded: false, restored: [], skippedListingFailed: true, orphanReportSignatures: prior.orphanReportSignatures };
  }

  const resolved = await resolvePendingLaunches(deps, sessions);
  if (resolved.malformed) {
    return { claimDegraded: false, agentsDegraded: true, restored: [], skippedListingFailed: false, orphanReportSignatures: prior.orphanReportSignatures };
  }

  // A fresh, unlocked peek to enumerate WHICH agent ids to consider this
  // cycle and to log currently-pending/unresolved launches. Never trusted
  // for a mutation decision — each per-agent decision below re-derives
  // itself from a lock-fresh read (R-F.3).
  const peeked = await loadAgents(deps.agentsPath);
  if (peeked.status === "malformed") {
    log("error", `agent store at "${deps.agentsPath}" became malformed mid-cycle: ${peeked.error} — degrading for the rest of this process's life`);
    return { claimDegraded: false, agentsDegraded: true, restored: [], skippedListingFailed: false, orphanReportSignatures: prior.orphanReportSignatures };
  }
  const peekedState = peeked.status === "loaded" ? peeked.state : emptyAgentStore();

  // BAKR-24 review finding: classification is memoized per KEY and shared
  // between the per-claim decide-or-report loop below AND the
  // unresolved-launches log loop, so a directory is probed at most once per
  // cycle regardless of how many things reference it.
  const claimsByKey = new Map(listClaims(claimState).map((c) => [c.key, c] as const));
  const classificationCache = new Map<ClaimKey, OrphanVerdict>();
  async function classifyKey(key: ClaimKey): Promise<OrphanVerdict> {
    const cached = classificationCache.get(key);
    if (cached !== undefined) return cached;
    const probe = await probeDirectory(key, deps.probeDeps);
    const verdict = classifyDirectory(probe, claimsByKey.get(key)?.dirIdentity?.dev);
    classificationCache.set(key, verdict);
    return verdict;
  }

  // BAKR-24 review finding: "the daemon must not loop on it" (Q4) was only
  // half delivered — this loop, at error level every cycle, otherwise still
  // fires FOREVER for a launch record left by a version of this daemon that
  // predates Q4 (an agent that was already orphaned before the operator
  // upgraded). A record this ticket's own code creates can never reach this
  // state (Q4 never creates one for an orphaned directory), but a
  // PRE-EXISTING one on disk can. Suppressed here when the agent's CURRENT
  // directory classifies as anything but `present` — the per-claim orphan
  // report below is the single voice for those agents instead, exactly once
  // per state change rather than every cycle. A record whose agent no
  // longer exists at all (should not happen; no delete verb ships yet)
  // still logs unconditionally rather than going silently missing.
  //
  // TWO suppressions guard this loop now, checked in this order: B13a
  // (below, BAKR-27 — a recognised stale-cwd refusal whose escape has since
  // succeeded) first, then Q4's directory classification above. Order
  // between them does not matter for correctness (they never overlap: a
  // B13a-superseded record's owning agent is, by construction, healthy and
  // its directory `present`), but B13a is checked first since it is the
  // cheaper, purely in-memory test.
  for (const unresolved of unresolvedLaunches(peekedState)) {
    // B13a (BAKR-27): a recognised stale-cwd refusal whose escape has since
    // resolved is not an unresolved launch — it was already reported once,
    // loudly, by the stale-cwd log line this same loop emits at the point
    // of refusal (see the `dispatch.kind === "forked"` branch below). This
    // is a REPORTING classification only — nothing is cleared, written, or
    // removed here (B13 stays intact); see `isSupersededStaleCwdRespawnFailure`'s
    // own doc for why this applies identically to a record THIS build just
    // created and to one a pre-B13a build already left on disk (AC6).
    if (isSupersededStaleCwdRespawnFailure(peekedState, unresolved, isRecognizedStaleCwdRefusal)) {
      continue;
    }
    const owner = peekedState.agents[unresolved.agentId];
    const verdict = owner === undefined ? undefined : await classifyKey(owner.directory);
    if (verdict !== undefined && verdict.status !== "present") {
      continue; // the orphan report (below) already covers this agent once per state change
    }
    log(
      "error",
      `unresolved launch for agent ${unresolved.agentId} in "${unresolved.key}" (attempt ${unresolved.attemptId}, ${new Date(unresolved.attemptedAt).toISOString()}): ${unresolved.error} — possibly orphaned; never retried automatically, never resolved by directory (BAKR-8 Constraint 2)`
    );
  }

  const restored: { agentId: string; key: ClaimKey; sessionId: string | undefined }[] = [];
  // BAKR-24 Q4: only entries for claims CURRENTLY orphaned (with >=1 `on`
  // agent) survive into next cycle's DaemonState — a directory that
  // resolves again, or loses its last `on` agent, simply has no entry here,
  // so a future re-orphaning reports fresh rather than staying silent.
  const nextOrphanReportSignatures: Record<string, string> = {};

  for (const claimEntry of listClaims(claimState)) {
    const key = claimEntry.key;
    const onAgents = agentsInDirectory(peekedState, key).filter((a) => a.state === "on");
    if (onAgents.length === 0) continue;

    // Q4: classify BEFORE deciding to launch anything. `gone`/`unavailable`
    // -> report, do not launch, and — critically — never call
    // `decideAndBeginForAgent` at all, so NO launch record is created
    // (a launch record here is exactly what would make
    // `hasLaunchRecordFor` silently suppress this agent's restore once the
    // directory comes back, per Q4's own "create no launch record at all").
    const verdict = await classifyKey(key);
    if (verdict.status !== "present") {
      const agentIds = onAgents.map((a) => a.id).sort();
      const signature = `${verdict.status}:${agentIds.join(",")}`;
      nextOrphanReportSignatures[key] = signature;
      if (prior.orphanReportSignatures[key] !== signature) {
        // [CORRECTED per Q4]: name the agent id(s), name the MISSING
        // DIRECTORY explicitly, and state the verdict — never echo a launch
        // failure's own ENOENT text (which misattributes the cause to
        // `systemd-run`). This log line is the only place that cause is
        // ever reported for these agents this cycle.
        log(
          verdict.status === "gone" ? "error" : "warn",
          `agent(s) ${agentIds.join(", ")}: claimed directory "${key}" no longer resolves (verdict: ${verdict.status}${verdict.status === "gone" ? `, ${verdict.confidence} confidence` : ""}) — ${verdict.reason}. NOT launching, no launch record created; this directory, not systemd-run, is the actual cause. Reported once per state change, not every cycle. Adopt these agents into a new directory to bring them back (BAKR-24).`
        );
      }
      continue;
    }

    for (const agent of onAgents) {
      const outcome = await decideAndBeginForAgent(deps, agent.id, key, sessions);
      if (outcome.malformed) {
        return { claimDegraded: false, agentsDegraded: true, restored, skippedListingFailed: false, orphanReportSignatures: prior.orphanReportSignatures };
      }
      const decision = outcome.decision as AgentDecision;

      if (decision.kind === "skip" || decision.kind === "alive" || decision.kind === "reset") {
        continue;
      }
      if (decision.kind === "not-verifiable") {
        log("warn", `agent ${agent.id} in "${key}": session ${decision.reason} — not restoring this cycle to avoid a duplicate; re-checked next cycle`);
        continue;
      }
      if (decision.kind === "give-up") {
        log(
          "error",
          `agent ${agent.id} in "${key}": giving up on respawning short id ${decision.shortId} after ${decision.attemptsSoFar} consecutive unverified restore attempts — the daemon must converge, not spawn unboundedly; see the unresolved-launch log for this attempt`
        );
        continue;
      }

      if (decision.kind === "begin-respawn") {
        // The write already landed inside the same lock hold as the
        // decision (R-F.3). Now respawn (or its stale-cwd forkFrom escape)
        // runs UNLOCKED (R-F: never hold the lock across a spawn).
        const dispatch = await dispatchRespawnForDaemon(deps, agent.id, key, decision.attemptId, decision.shortId, decision.restoreSessionId);
        if (dispatch.kind === "respawned") {
          log("info", `agent ${agent.id} in "${key}": respawned short id ${decision.shortId} — same session, no fork, per BAKR-22's own measurement`);
          restored.push({ agentId: agent.id, key, sessionId: decision.restoreSessionId });
        } else if (dispatch.kind === "forked") {
          if (dispatch.abandonedSessionId !== undefined) {
            // BAKR-22 EPIC REQUIREMENT: `fresh` was chosen for a MOVED agent
            // (confirmed no-transcript, per `probeResumableTranscript`) —
            // report it LOUDLY, naming the agent and the abandoned session
            // id, so this never reads like an ordinary successful escape.
            log(
              "error",
              `agent ${agent.id} in "${key}": respawn REFUSED with the recognised stale-cwd shape — the job's registered directory no longer matches "${key}". Session ${dispatch.abandonedSessionId} was CONFIRMED to have no resumable transcript (probeResumableTranscript), so a FRESH session was started instead of forking — session ${dispatch.abandonedSessionId} is now abandoned${dispatch.newShortId !== undefined ? ` (new short id ${dispatch.newShortId}; awaiting a future listing to confirm its new session id and advance restoreTarget)` : ", but the fresh launch itself also failed — see the unresolved-launch log"}. This is the ONE case restoreTarget still moves; birthSessionId is untouched.`
            );
          } else {
            log(
              "error",
              `agent ${agent.id} in "${key}": respawn REFUSED with the recognised stale-cwd shape — the job's registered directory no longer matches "${key}". Escaped via forkFrom (--fork-session) resuming session ${decision.restoreSessionId}${dispatch.newShortId !== undefined ? ` -> new short id ${dispatch.newShortId}; awaiting a future listing to confirm its new session id and advance restoreTarget` : ", but the fork launch itself also failed — see the unresolved-launch log"}. This is the ONE case restoreTarget still moves; birthSessionId is untouched.`
            );
          }
        } else {
          log(
            "error",
            `agent ${agent.id} in "${key}": respawn REFUSED: ${dispatch.error} — an unrecognised failure never falls through to forkFrom (that would risk abandoning a live conversation on a guess); recorded as unresolved, never retried automatically (BAKR-8 Constraint 2)`
          );
        }
        continue;
      }

      // begin-fresh-launch only from here on.
      const launchResult = await launch(key, [], { runCommand: deps.runCommand });
      if (launchResult.ok) {
        await recordLaunchOutcome(deps, decision.attemptId, launchResult);
        log("info", `agent ${agent.id} in "${key}": fresh launch issued -> short id ${launchResult.id}; awaiting a future listing to learn its session id`);
        restored.push({ agentId: agent.id, key, sessionId: undefined });
      } else {
        await recordLaunchOutcome(deps, decision.attemptId, launchResult);
        const staleRegisteredCwd = detectStaleRegisteredCwdRefusal(launchResult.error);
        if (staleRegisteredCwd !== undefined) {
          // BAKR-24: a SPECIFIC, LOUD report for this one failure shape —
          // claude's OWN internal job registry (not anything bakr writes or
          // owns) still points at a stale path, refusing to restart this
          // agent even though it now genuinely lives at `key`. Measured
          // version-dependent (present on some claude builds, not others,
          // enforced differently across them) — never asserted here as
          // universal, and never worked around by writing into
          // claude's own storage (that decision is the epic's alone).
          log(
            "error",
            `agent ${agent.id}: adoption/restore into "${key}" REFUSED by claude itself — its own internal session registry still points at the STALE path "${staleRegisteredCwd}" (not "${key}", where this agent actually now lives) and refuses to restart until that registry entry is updated. This is a claude-build-dependent limitation outside bakr's own storage (BAKR-24) — bakr does not write into claude's registry to work around it. Never retried automatically (BAKR-8 Constraint 2).`
          );
        } else {
          log(
            "error",
            `agent ${agent.id} in "${key}": launch failed: ${launchResult.error} — cannot distinguish "never detached" from "detached, then the wrapper failed"; treated as possibly orphaned, recorded as unresolved, never retried automatically (BAKR-8 Constraint 2)`
          );
        }
      }
    }
  }

  return { claimDegraded: false, agentsDegraded: false, restored, skippedListingFailed: false, orphanReportSignatures: nextOrphanReportSignatures };
}

export interface DaemonLoopOptions {
  readonly intervalMs: number;
  readonly signal?: AbortSignal;
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

/**
 * The daemon's own loop: reconcile, sleep, repeat, forever (or until
 * `options.signal` aborts). A single cycle throwing is caught and logged,
 * never crashing the daemon and never skipping the cycles after it.
 */
export async function runDaemonLoop(deps: DaemonDeps, options: DaemonLoopOptions): Promise<void> {
  let state: DaemonState = initialDaemonState();
  log("info", `bakr daemon starting: claims="${deps.claimsPath}" agents="${deps.agentsPath}" interval=${options.intervalMs}ms`);
  while (options.signal?.aborted !== true) {
    try {
      const result = await runReconcileCycle(state, deps);
      state = { claimDegraded: result.claimDegraded, agentsDegraded: result.agentsDegraded, orphanReportSignatures: result.orphanReportSignatures };
    } catch (err) {
      log("error", `reconcile cycle threw and was caught, daemon continues: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    }
    await sleep(options.intervalMs, options.signal);
  }
  log("info", "bakr daemon loop stopped (abort signal)");
}
