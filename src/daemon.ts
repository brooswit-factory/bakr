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
  putAgent,
  type AgentRecord,
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
  clearFailedLaunchRecord,
  promoteUnresolvableLaunches,
  restoreAttemptCount,
  recordRestoreAttempt,
  resetRestoreAttempts,
  planRestore,
} from "./agent-model";
import { claudeLaunchArgs, expectedClaudeLaunchArgs, provisionMcpFor, type LaunchConfigDeps, type McpServerDeclaration } from "./launch-config";
import { listBackgroundSessions, decideLiveness, checkLiveness, isPidAlive, isHerdrPaneId, launch, readPaneArgv, respawnSession, isRecognizedStaleCwdRefusal, detectStaleRegisteredCwdRefusal, type RunCommand, type BackgroundSessionInfo } from "./spawn";
import { checkAgentArgv } from "./argv-check";
import { relaunch, type AgentActionDeps } from "./agent-actions";
import { probeResumableTranscript, type TranscriptProbeDeps } from "./transcript-probe";
import { realTranscriptProbeDeps, realLaunchConfigDeps, realResumeCwdDeps } from "./paths";
import { resumeCwdFor, type ResumeCwdDeps } from "./resume-cwd";
import type { ClaimKey } from "./claim-key-resolve";
import { classifyDirectory, type OrphanVerdict } from "./orphan-model";
import { probeDirectory, type OrphanProbeDeps } from "./orphan-probe";
import { log } from "./log";

/** See session-slots.ts's own module comment for the live incident this bound closes — ported unchanged. Now counted per AGENT id (R-C), not per durable session id. */
const MAX_CONSECUTIVE_UNVERIFIED_RESTORES = 3;

/**
 * BAKR-61: how many times in a row this process relaunches one agent whose
 * live argv does not match what bakr launches it with, before it stops and
 * says so. A relaunch that still comes back mismatched means bakr's own launch
 * and its own check disagree; relaunching again would only kill and restart a
 * live session forever. Counted in memory, per agent, reset by a match — so a
 * daemon restart (the evidence a reboot brings) gets a fresh look.
 */
const MAX_CONSECUTIVE_ARGV_RELAUNCHES = 2;

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
  /** How to read a directory's `.mcp.json` and write its MCP approval (launch-config.ts). Optional — defaults to the real filesystem (`realLaunchConfigDeps`, paths.ts), so every existing caller and test needs no change. */
  readonly launchConfigDeps?: LaunchConfigDeps;
  /** Where a session last ran, so a restore resumes there (resume-cwd.ts). Defaults to reading its real transcript. */
  readonly resumeCwdDeps?: ResumeCwdDeps;
  readonly acquireTimeoutMs?: number;
  /** BAKR-61: the waits and probes of the relaunch an argv mismatch triggers (`relaunch`'s own deps). Optional — each defaults to the real one; tests pass instant ones. */
  readonly relaunch?: Pick<AgentActionDeps, "sleep" | "isPidAlive" | "readTranscript">;
}

/** The agent's own MCP declaration, read fresh from the store; `undefined` (the default: every server its `.mcp.json` configures) when it has none or the store cannot be read. */
async function declaredMcp(deps: DaemonDeps, agentId: string): Promise<readonly McpServerDeclaration[] | undefined> {
  const loaded = await loadAgents(deps.agentsPath);
  return loaded.status === "loaded" ? loaded.state.agents[agentId]?.mcp : undefined;
}

/** Every `launch()` in this loop carries this, after its MCP approval is written; `respawnSession` deliberately carries no flags (see launch-config.ts's module comment). */
const configuredLaunchArgs = async (deps: DaemonDeps, directory: string, agentId: string): Promise<string[]> =>
  claudeLaunchArgs(directory, deps.launchConfigDeps ?? realLaunchConfigDeps, await declaredMcp(deps, agentId));

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
  /**
   * BAKR-33: `true` until this process's per-agent decision loop
   * (`decideAndBeginForAgent`, below) has been reached at least once, then
   * `false` for the rest of this process's life — never re-armed, never
   * re-derived from anything on disk. This is the ONE bounded exception to
   * B7/B13's "never retried automatically" for a respawn plan already
   * blocked by an existing FAILED launch record: on the first cycle only,
   * AND only when a fresh liveness check this same cycle independently
   * verifies the record's target `absent` right now, that one record is
   * superseded (`clearFailedLaunchRecord`) and a normal restore attempt
   * proceeds — the daemon's own equivalent of an operator running `on`
   * again after this daemon's own process was restarted (however that
   * restart was triggered — an operator-issued service restart, or the
   * host itself rebooting) — see `decideAndBeginForAgent`'s own doc. Every cycle
   * after the first treats an existing failed record exactly as permanent
   * as before this ticket; this flag is what makes that bound structural
   * rather than a matter of remembering to check.
   *
   * OPTIONAL, defaulting to `false` wherever read (never `true`) — so every
   * `DaemonState` object literal that predates this ticket (scripts,
   * fixtures, hand-built test states) keeps compiling and keeps behaving
   * exactly as it did before: no bypass privilege it never asked for. Only
   * `initialDaemonState()` sets it `true` — the one true "a process just
   * started" signal in this tree.
   */
  readonly isFirstCycle?: boolean;
  /**
   * BAKR-61: consecutive argv relaunches per agent id — see
   * `MAX_CONSECUTIVE_ARGV_RELAUNCHES`. An agent whose argv matches has no
   * entry. OPTIONAL for the same reason as `isFirstCycle`: an older literal
   * starts every agent at zero.
   */
  readonly argvRelaunches?: Readonly<Record<string, number>>;
}

export function initialDaemonState(): DaemonState {
  return { claimDegraded: false, agentsDegraded: false, orphanReportSignatures: {}, isFirstCycle: true };
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
  /** See `DaemonState.isFirstCycle` — carried forward into the next cycle's `DaemonState` by `runDaemonLoop`, exactly like `orphanReportSignatures`. OPTIONAL for the identical reason: a pre-BAKR-33 literal that omits it defaults to `false` wherever read. */
  readonly isFirstCycle?: boolean;
  /** See `DaemonState.argvRelaunches` — carried forward by `runDaemonLoop`. */
  readonly argvRelaunches?: Readonly<Record<string, number>>;
}

/**
 * How old a launch record with no outcome must be before it counts as wedged.
 * This check runs every cycle, and a record with no outcome yet is also what
 * ANOTHER process's launch looks like while it is still in flight — a CLI
 * `on`/`relaunch` waiting on its herdr pane (seconds, up to a few minutes
 * with startup prompts). Measured: without a grace window the daemon marked
 * butchr's in-flight restore "crashed" mid-launch (2026-09-18). A herdr
 * launch gives up well inside this window, so an older record is genuinely
 * abandoned.
 */
const WEDGED_LAUNCH_GRACE_MS = 10 * 60_000;

/** Promotes any launch record left wedged by a crash mid-`launch()` — see agent-model.ts's own `promoteUnresolvableLaunches` doc, ported unchanged in spirit, rekeyed to agent id — but only once it is older than any launch could still be running. One locked mutation; a no-op save is skipped. */
async function promoteWedgedLaunches(deps: DaemonDeps): Promise<{ malformed: boolean; error?: string }> {
  const cutoff = deps.now() - WEDGED_LAUNCH_GRACE_MS;
  const result = await withAgentStoreLock(
    deps.agentsPath,
    (current) => {
      const wedged = current.launches.filter((l) => l.launchShortId === undefined && l.error === undefined && l.attemptedAt <= cutoff);
      if (wedged.length === 0) {
        return { state: current, result: [] as typeof wedged };
      }
      const next = promoteUnresolvableLaunches(
        current,
        "the daemon process ended before this launch's outcome was recorded (crashed, or was killed, mid-launch) — cannot distinguish never-detached from detached-then-the-wrapper-failed (BAKR-8 Constraint 2)",
        cutoff
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
  /** `supersededStaleRecord`: BAKR-33 — set only when this attempt exists BECAUSE the first-cycle-verified-absent exception (below) superseded an existing FAILED record at this exact key; absent (not merely `false`) on every ordinary `begin-respawn`. */
  | { readonly kind: "begin-respawn"; readonly attemptId: string; readonly shortId: string; readonly restoreSessionId: string; readonly supersededStaleRecord?: true };

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
 *
 * `isFirstCycle` (BAKR-33): see `DaemonState.isFirstCycle`'s own doc — the
 * ONE bounded exception to "a FAILED respawn-keyed record blocks forever"
 * (B7/B13), gated on this being the first reconcile cycle since this
 * process started AND a fresh liveness check this same cycle independently
 * verifying the record's target `absent` right now. See the respawn branch
 * below for exactly where it applies — nowhere else in this function reads
 * it (a `fresh` plan has no prior target to verify absent against at all).
 */
export async function decideAndBeginForAgent(deps: DaemonDeps, agentId: string, key: ClaimKey, sessions: readonly BackgroundSessionInfo[], isFirstCycle: boolean = false): Promise<{ malformed: boolean; error?: string; decision?: AgentDecision }> {
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
      // Matched by SESSION id: under herdr a restore resumes the same session in a new pane, so the
      // short id (the pane) changes while the session id does not. A session alive in any pane is alive.
      // COMPUTED BEFORE the hasLaunchRecordFor guard below (BAKR-33): the
      // one bounded exception needs this cycle's own fresh verdict to
      // decide whether an existing FAILED record may be superseded at all.
      const entry = sessions.find((s) => s.sessionId === agent.restoreTarget?.sessionId) ?? sessions.find((s) => s.id === shortId);
      const pidVerifiedAlive = entry?.pid !== undefined ? isPidAlive(entry.pid) : false;
      const verdict = decideLiveness(shortId, entry, pidVerifiedAlive);

      let store = current;
      let supersededStaleRecord = false;
      if (hasLaunchRecordFor(store, agentId, attemptKey)) {
        // BAKR-33 (reviewer lead-bakr, escalation 2026-09-18): normally this
        // is a hard, permanent block (B7/B13) — a FAILED record at this
        // exact key never automatically retries, by design, so the daemon
        // never flaps against a persistently broken target. The ONE bounded
        // exception: the very first reconcile cycle since THIS PROCESS
        // started (`isFirstCycle`), and ONLY when the verdict just computed
        // above independently verifies the target `absent` right now — the
        // daemon's own equivalent of an operator running `on` again after a
        // restart. Never on `alive` or `not-verifiable`: those still skip,
        // identically to every cycle after the first. A still-PENDING
        // record (genuinely in-flight, `error === undefined`) is NEVER
        // superseded either way — `clearFailedLaunchRecord` is a no-op
        // against one, so `superseded === store` below catches that case
        // and still skips, exactly as before this ticket.
        if (!isFirstCycle || verdict.status !== "absent") {
          return { state: current, result: { kind: "skip" } };
        }
        const superseded = clearFailedLaunchRecord(store, agentId, attemptKey);
        if (superseded === store) {
          return { state: current, result: { kind: "skip" } };
        }
        store = superseded;
        supersededStaleRecord = true;
      }

      if (verdict.status === "alive") {
        if (restoreAttemptCount(store, agentId) > 0) {
          return { state: resetRestoreAttempts(store, agentId), result: { kind: "reset" } };
        }
        return { state: store, result: { kind: "alive" } };
      }
      if (verdict.status === "not-verifiable") {
        return { state: store, result: { kind: "not-verifiable", reason: verdict.reason } };
      }

      const attemptsSoFar = restoreAttemptCount(store, agentId);
      if (attemptsSoFar >= MAX_CONSECUTIVE_UNVERIFIED_RESTORES) {
        const giveUpAttemptId = deps.generateAttemptId();
        let next = beginLaunch(store, agentId, key, attemptKey, giveUpAttemptId, deps.now());
        next = markLaunchFailed(
          next,
          giveUpAttemptId,
          `gave up after ${attemptsSoFar} consecutive restore attempts for this agent, none independently verified alive — likely a silently-failing resume (ticket measurement 5); never retried automatically (BAKR-8 Constraint 2)`
        );
        return { state: next, result: { kind: "give-up", attemptsSoFar, shortId } };
      }

      const attemptId = deps.generateAttemptId();
      let next = beginLaunch(store, agentId, key, attemptKey, attemptId, deps.now());
      next = recordRestoreAttempt(next, agentId);
      return {
        state: next,
        result: { kind: "begin-respawn", attemptId, shortId, restoreSessionId: agent.restoreTarget?.sessionId ?? shortId, ...(supersededStaleRecord ? { supersededStaleRecord: true as const } : {}) },
      };
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
  const recheck = await checkLiveness(shortId, { runCommand: deps.runCommand }, restoreSessionId);
  if (recheck.status !== "absent") {
    const reason = recheck.status === "alive" ? `verified alive with pid ${recheck.pid}` : recheck.reason;
    const error = `respawn refused: TOCTOU re-check reported "${recheck.status}" for session ${shortId} (${reason}) — only "absent" (a listing that succeeded and genuinely did not find it) proceeds; an operator likely attached since the decision was made, or the re-check listing itself failed, so this is not killed`;
    await withAgentStoreLock(deps.agentsPath, (current) => ({ state: markLaunchFailed(current, attemptId, error), result: undefined }), lockOpts(deps));
    return { kind: "refused", error };
  }

  // A restore resumes the same session in a new pane, with the agent's CURRENT flags and approval,
  // in the directory the conversation last ran in (a worktree, say) — claude refuses a resume anywhere else.
  const args = await configuredLaunchArgs(deps, key, agentId);
  const where = await resumeCwdFor(restoreSessionId, key, deps.resumeCwdDeps ?? realResumeCwdDeps);
  const result = await respawnSession({ sessionId: restoreSessionId, directory: where, args }, { runCommand: deps.runCommand, label: agentId });
  if (result.ok) {
    await withAgentStoreLock(deps.agentsPath, (current) => ({ state: resolveRespawnAttempt(current, attemptId, result.id), result: undefined }), lockOpts(deps));
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
    const configured = await configuredLaunchArgs(deps, key, agentId);
    const forkResult = canForkFrom
      ? await launch(key, ["--resume", restoreSessionId, "--fork-session", ...configured], { runCommand: deps.runCommand, label: agentId })
      : await launch(key, configured, { runCommand: deps.runCommand, label: agentId });
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

/** `prior`'s argv relaunch counts, for a cycle that decided nothing about any agent. */
const carryArgv = (prior: DaemonState): { argvRelaunches?: Readonly<Record<string, number>> } =>
  prior.argvRelaunches === undefined ? {} : { argvRelaunches: prior.argvRelaunches };

/** The operator verbs' deps, from the daemon's own: what `relaunch` needs to replace a session. */
function actionDepsFor(deps: DaemonDeps): AgentActionDeps {
  return {
    agentsPath: deps.agentsPath,
    runCommand: deps.runCommand,
    now: deps.now,
    generateAttemptId: deps.generateAttemptId,
    randomBytes: deps.randomBytes,
    ...(deps.acquireTimeoutMs === undefined ? {} : { acquireTimeoutMs: deps.acquireTimeoutMs }),
    ...(deps.transcriptProbeDeps === undefined ? {} : { transcriptProbeDeps: deps.transcriptProbeDeps }),
    ...(deps.launchConfigDeps === undefined ? {} : { launchConfigDeps: deps.launchConfigDeps }),
    ...(deps.resumeCwdDeps === undefined ? {} : { resumeCwdDeps: deps.resumeCwdDeps }),
    ...deps.relaunch,
  };
}

/**
 * BAKR-61: an agent the liveness check just called alive is only healthy if
 * its claude runs with the flags bakr launches it with now. herdr's own
 * resume-on-restore brings a pane back after a reboot as a bare
 * `claude --resume <id>` — same pane, same session, no channels — and before
 * this check the daemon adopted every one of those as healthy while the agents
 * were deaf (2026-09-19). A mismatch is replaced by `relaunch` — the operator
 * verb, so the same stop, wait, resume-in-place and bookkeeping — on the SAME
 * session id, through drovr's hostResident.
 *
 * Returns this agent's consecutive-relaunch count to carry into the next cycle
 * (`undefined`: none). Never relaunches when:
 *   - the argv or the launch config cannot be read — couldn't check is not a
 *     mismatch; the count is carried unchanged;
 *   - the session is mid-turn — `relaunch` refuses, and the next idle cycle
 *     tries again without counting it;
 *   - it has already relaunched this agent `MAX_CONSECUTIVE_ARGV_RELAUNCHES`
 *     times in a row and the argv still does not match — it logs that once
 *     and waits for an operator (or a match, or a daemon restart).
 * A relaunch whose replacement fails leaves `relaunch` parking the agent
 * `off`; the daemon turns it back `on` so its ordinary restore — which carries
 * the configured flags — brings it back, bounded by its own attempt limit,
 * and `bakr status` keeps reporting it rather than hiding an `off` agent.
 */
async function reconcileArgv(deps: DaemonDeps, agentId: string, key: ClaimKey, sessions: readonly BackgroundSessionInfo[], prior: number): Promise<number | undefined> {
  const carry = prior > 0 ? prior : undefined;
  const loaded = await loadAgents(deps.agentsPath);
  const agent = loaded.status === "loaded" ? loaded.state.agents[agentId] : undefined;
  const target = agent?.restoreTarget;
  if (agent === undefined || agent.state !== "on" || target === undefined) return carry;
  const entry = sessions.find((s) => s.sessionId === target.sessionId);
  // A legacy `claude --bg` session has no pane to read an argv from; `relaunch` is how it moves to one anyway.
  if (entry === undefined || !isHerdrPaneId(entry.id)) return carry;

  const [live, expected] = await Promise.all([
    readPaneArgv(entry.id, deps.runCommand),
    expectedClaudeLaunchArgs(key, deps.launchConfigDeps ?? realLaunchConfigDeps, agent.mcp).catch(() => undefined),
  ]);
  if (!live.ok || expected === undefined) return carry;
  const verdict = checkAgentArgv(expected, live.argv, target.sessionId);
  if (verdict.ok) return undefined;

  if (prior >= MAX_CONSECUTIVE_ARGV_RELAUNCHES) {
    if (prior === MAX_CONSECUTIVE_ARGV_RELAUNCHES) {
      log("error", `agent ${agentId} in "${key}": pane ${entry.id} still runs session ${target.sessionId} without bakr's launch flags (${verdict.reason}) after ${prior} relaunches in a row — not relaunching again; bakr's launch and its argv check disagree, and an operator must look (BAKR-61). \`bakr status\` reports it as argv-mismatch.`);
    }
    return MAX_CONSECUTIVE_ARGV_RELAUNCHES + 1;
  }

  log("warn", `agent ${agentId} in "${key}": pane ${entry.id} runs session ${target.sessionId} without bakr's launch flags (${verdict.reason}) — not healthy; relaunching the same session with them (BAKR-61)`);
  const result = await relaunch(actionDepsFor(deps), key, agentId);
  if (result.ok) {
    log("info", `agent ${agentId} in "${key}": relaunched session ${result.next.sessionId} in pane ${result.next.shortId} (was ${result.previous.shortId}) with its launch flags`);
    return prior + 1;
  }
  if (result.reason === "busy") {
    log("info", `agent ${agentId} in "${key}": ${result.message} — its argv relaunch waits for it to be idle`);
    return carry;
  }
  if (result.reason === "launch-failed" || result.reason === "unlisted") {
    await withAgentStoreLock(deps.agentsPath, (current) => {
      const now = current.agents[agentId];
      return { state: now === undefined || now.state !== "off" ? current : putAgent(current, { ...now, state: "on" }), result: undefined };
    }, lockOpts(deps));
    log("error", `agent ${agentId} in "${key}": the argv relaunch stopped session ${target.sessionId} but its replacement did not come up (${result.message}) — turned back on so the ordinary restore brings it back with its flags`);
    return prior + 1;
  }
  log("warn", `agent ${agentId} in "${key}": argv relaunch refused (${result.reason}): ${result.message}`);
  return prior + 1;
}

/**
 * One reconcile cycle. See the module comment for the R-F.3 discipline this
 * function's per-agent helper enforces. Exactly ONE session listing per
 * cycle (herdr panes plus legacy background sessions). A listing failure
 * makes the WHOLE cycle a no-op with a loud log (BAKR-8 Constraint 1). Only
 * `on` agents are ever considered for launch (B7) — an `off` or `archived`
 * agent is never touched, and no code path in this file stops a running
 * session. (A launch that fails closes the herdr workspace it itself just
 * created — see spawn/herdr.ts — never one it found running.)
 */
export async function runReconcileCycle(prior: DaemonState, deps: DaemonDeps): Promise<ReconcileResult> {
  if (prior.claimDegraded || prior.agentsDegraded) {
    const parts: string[] = [];
    if (prior.claimDegraded) parts.push(`claim store "${deps.claimsPath}" is malformed`);
    if (prior.agentsDegraded) parts.push(`agent store at "${deps.agentsPath}" (or its pre-migration session-slots.json) is malformed`);
    log("error", `reconcile skipped this cycle: ${parts.join("; ")} — this process will never write to the affected file(s); restart after repairing on disk`);
    return { claimDegraded: prior.claimDegraded, agentsDegraded: prior.agentsDegraded, restored: [], skippedListingFailed: false, orphanReportSignatures: prior.orphanReportSignatures, isFirstCycle: prior.isFirstCycle ?? false, ...carryArgv(prior) };
  }

  const { claimState, claimDegraded, agentsDegraded } = await loadStores(deps);
  if (claimDegraded || agentsDegraded) {
    return { claimDegraded, agentsDegraded, restored: [], skippedListingFailed: false, orphanReportSignatures: prior.orphanReportSignatures, isFirstCycle: prior.isFirstCycle ?? false, ...carryArgv(prior) };
  }

  const promoted = await promoteWedgedLaunches(deps);
  if (promoted.malformed) {
    return { claimDegraded: false, agentsDegraded: true, restored: [], skippedListingFailed: false, orphanReportSignatures: prior.orphanReportSignatures, isFirstCycle: prior.isFirstCycle ?? false, ...carryArgv(prior) };
  }

  let sessions: BackgroundSessionInfo[];
  try {
    sessions = await listBackgroundSessions({ runCommand: deps.runCommand });
  } catch (err) {
    log(
      "error",
      `reconcile skipped this cycle: the session listing failed: ${err instanceof Error ? err.message : String(err)} — never treated as "nothing running"; no restore is issued this cycle (BAKR-8 Constraint 1)`
    );
    return { claimDegraded: false, agentsDegraded: false, restored: [], skippedListingFailed: true, orphanReportSignatures: prior.orphanReportSignatures, isFirstCycle: prior.isFirstCycle ?? false, ...carryArgv(prior) };
  }

  const resolved = await resolvePendingLaunches(deps, sessions);
  if (resolved.malformed) {
    return { claimDegraded: false, agentsDegraded: true, restored: [], skippedListingFailed: false, orphanReportSignatures: prior.orphanReportSignatures, isFirstCycle: prior.isFirstCycle ?? false, ...carryArgv(prior) };
  }

  // A fresh, unlocked peek to enumerate WHICH agent ids to consider this
  // cycle and to log currently-pending/unresolved launches. Never trusted
  // for a mutation decision — each per-agent decision below re-derives
  // itself from a lock-fresh read (R-F.3).
  const peeked = await loadAgents(deps.agentsPath);
  if (peeked.status === "malformed") {
    log("error", `agent store at "${deps.agentsPath}" became malformed mid-cycle: ${peeked.error} — degrading for the rest of this process's life`);
    return { claimDegraded: false, agentsDegraded: true, restored: [], skippedListingFailed: false, orphanReportSignatures: prior.orphanReportSignatures, isFirstCycle: prior.isFirstCycle ?? false, ...carryArgv(prior) };
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
  // BAKR-33: true when `agent`'s CURRENT restore target independently
  // verifies alive, right now, in THIS cycle's own listing — the identical
  // OS-level check `decideAndBeginForAgent`'s own "alive" verdict is built
  // on (`decideLiveness` + `isPidAlive`), reapplied here purely as a
  // REPORTING classification, exactly like `isSupersededStaleCwdRespawnFailure`
  // right below: nothing is cleared, written, or removed by this check.
  // `unresolved`'s own key is irrelevant on purpose — a stale record under
  // ANY key (an old shortId from a past failure, say) says nothing about
  // whether the agent it names is fine RIGHT NOW; only the agent's CURRENT
  // `restoreTarget` does. This is what stops a healthy agent's old failed
  // launch from being re-logged as an ERROR on the very first cycle after a
  // restart: restarting the small bakr process does not touch the agents'
  // own long-running sessions, so most verify alive on cycle one, before
  // any NEW respawn ever runs to trigger this ticket's other fix (dropping
  // the record for good — see `resolveRespawnAttempt`/`resolveLaunch`'s own
  // doc — once this agent's NEXT respawn/relaunch actually resolves).
  const isVerifiedAliveNow = (agent: AgentRecord | undefined): boolean => {
    const target = agent?.restoreTarget;
    if (target === undefined) return false;
    const entry = sessions.find((s) => s.sessionId === target.sessionId) ?? sessions.find((s) => s.id === target.shortId);
    const pidVerifiedAlive = entry?.pid !== undefined && isPidAlive(entry.pid);
    return decideLiveness(target.shortId, entry, pidVerifiedAlive).status === "alive";
  };

  // THREE suppressions guard this loop now, checked in this order: BAKR-33
  // (just above — an agent independently verified alive right now) first
  // since it is the next cheapest purely-in-memory-plus-this-cycle's-own-
  // listing test, then B13a (below, BAKR-27 — a recognised stale-cwd
  // refusal whose escape has since succeeded), then Q4's directory
  // classification. Order between them does not matter for correctness
  // (none overlap: a suppressed record's owning agent is, by construction,
  // healthy and its directory `present`).
  for (const unresolved of unresolvedLaunches(peekedState)) {
    if (isVerifiedAliveNow(peekedState.agents[unresolved.agentId])) {
      continue;
    }
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
  // BAKR-61: only agents still counting carry an entry; one that matches, or is no longer `on`, drops out.
  const nextArgvRelaunches: Record<string, number> = {};

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
      const outcome = await decideAndBeginForAgent(deps, agent.id, key, sessions, prior.isFirstCycle);
      if (outcome.malformed) {
        return { claimDegraded: false, agentsDegraded: true, restored, skippedListingFailed: false, orphanReportSignatures: prior.orphanReportSignatures, isFirstCycle: false, ...carryArgv(prior) };
      }
      const decision = outcome.decision as AgentDecision;

      if (decision.kind === "alive" || decision.kind === "reset") {
        const count = await reconcileArgv(deps, agent.id, key, sessions, prior.argvRelaunches?.[agent.id] ?? 0);
        if (count !== undefined) nextArgvRelaunches[agent.id] = count;
        continue;
      }
      if (decision.kind === "skip") {
        const count = prior.argvRelaunches?.[agent.id];
        if (count !== undefined) nextArgvRelaunches[agent.id] = count;
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
        if (decision.supersededStaleRecord) {
          // BAKR-33: this cycle's own fresh liveness check independently
          // verified `decision.shortId` absent, and this was the first
          // reconcile cycle since this process started — the daemon's own
          // equivalent of an operator running `on` again after a restart.
          // Loud and explicit, per B13's own "the clearing must be
          // reported... never done silently" — same standard as the
          // operator verbs' `launchWedgeCleared`.
          log(
            "warn",
            `agent ${agent.id} in "${key}": a FAILED launch record for short id ${decision.shortId} was superseded — this is the FIRST reconcile cycle since this process started, and a fresh check just verified that target is absent right now (BAKR-33: a process restart gets one evidence-gated look, never a repeating retry). Attempting a normal restore.`
          );
        }
        // The write already landed inside the same lock hold as the
        // decision (R-F.3). Now respawn (or its stale-cwd forkFrom escape)
        // runs UNLOCKED (R-F: never hold the lock across a spawn).
        const dispatch = await dispatchRespawnForDaemon(deps, agent.id, key, decision.attemptId, decision.shortId, decision.restoreSessionId);
        if (dispatch.kind === "respawned") {
          log("info", `agent ${agent.id} in "${key}": restored session ${decision.restoreSessionId} into a new herdr pane (was ${decision.shortId}) — same session, no fork`);
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
      const launchResult = await launch(key, await configuredLaunchArgs(deps, key, agent.id), { runCommand: deps.runCommand, label: agent.id });
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

  return { claimDegraded: false, agentsDegraded: false, restored, skippedListingFailed: false, orphanReportSignatures: nextOrphanReportSignatures, isFirstCycle: false, argvRelaunches: nextArgvRelaunches };
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
      state = { claimDegraded: result.claimDegraded, agentsDegraded: result.agentsDegraded, orphanReportSignatures: result.orphanReportSignatures, isFirstCycle: result.isFirstCycle ?? false, ...(result.argvRelaunches === undefined ? {} : { argvRelaunches: result.argvRelaunches }) };
    } catch (err) {
      log("error", `reconcile cycle threw and was caught, daemon continues: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    }
    await sleep(options.intervalMs, options.signal);
  }
  log("info", "bakr daemon loop stopped (abort signal)");
}
