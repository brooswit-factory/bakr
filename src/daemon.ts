// The daemon's own reconcile cycle and loop (BAKR-12, implementing story
// BAKR-8). Wires together the claim store (BAKR-6, read-only from here —
// nothing in this file ever claims or releases a directory) and the spawn
// substrate (BAKR-7) via bakr's own session-slots store (see
// session-slots.ts) to bring back, silently, every claimed directory's
// on-sessions.
//
// Structured like brooswit-factory/candlestix's own src/supervisor.ts
// (verified at candlestix's commit 3801992aae149271e273a3ee48247978b1df6e8c):
// one listing per cycle, a per-item try/catch so one bad item costs only
// itself, and a cycle-level try/catch in the loop (below) so one bad cycle
// costs only itself — ported as a *pattern*, not literal code, since this
// module's decision shape (restore vs. heartbeat) differs from candlestix's
// own reconcile.ts.
//
// Every launch this file issues goes through spawn/launch.ts's own
// systemd-run --user --scope wrapper — this file never constructs a `claude
// --bg` invocation itself, and never stops or resolves a session by
// directory (BAKR-8's hazard rules).

import { load as loadClaims } from "./claim-store-io";
import { list as listClaims, emptyStore, type ClaimStoreState } from "./claim-model";
import { load as loadSlots, save as saveSlots } from "./session-slots-store";
import {
  emptySessionSlots,
  sessionsOn,
  beginLaunch,
  markLaunchStarted,
  markLaunchFailed,
  resolveLaunch,
  pendingLaunches,
  unresolvedLaunches,
  hasLaunchRecordFor,
  type SessionSlotsState,
} from "./session-slots";
import { listBackgroundSessions, decideLiveness, isPidAlive, launch, type RunCommand } from "./spawn";
import type { ClaimKey } from "./claim-key-resolve";
import { log } from "./log";

export interface DaemonDeps {
  readonly runCommand: RunCommand;
  readonly claimsPath: string;
  readonly sessionSlotsPath: string;
  readonly now: () => number;
  readonly generateAttemptId: () => string;
}

export interface DaemonState {
  readonly claimDegraded: boolean;
  readonly sessionSlotsDegraded: boolean;
}

export function initialDaemonState(): DaemonState {
  return { claimDegraded: false, sessionSlotsDegraded: false };
}

interface LoadedStores {
  readonly claimState: ClaimStoreState;
  readonly sessionSlotsState: SessionSlotsState;
  readonly claimDegraded: boolean;
  readonly sessionSlotsDegraded: boolean;
}

/**
 * Loads both of bakr's own stores fresh from disk. Constraint 3 (BAKR-8):
 * `missing` is a SUCCESS (first run — empty, starts normally); `malformed`
 * degrades that store for the rest of this process's life — see
 * `runReconcileCycle`, which never calls this again once a prior cycle
 * already returned a degraded flag, so a degraded store is never re-read
 * and never re-considered "maybe fine now." The session slots store gets
 * the identical discipline as the claim store, for the identical reason —
 * see session-slots-store.ts's own module comment for why it is in the
 * same unreconstructable-from-nothing position the claim store is in.
 */
async function loadStores(deps: DaemonDeps): Promise<LoadedStores> {
  const claimResult = await loadClaims(deps.claimsPath);
  let claimState: ClaimStoreState;
  let claimDegraded = false;
  if (claimResult.status === "malformed") {
    claimDegraded = true;
    claimState = emptyStore();
    log(
      "error",
      `claim store at "${deps.claimsPath}" is malformed: ${claimResult.error} — starting/continuing degraded: restoring nothing, never writing to this file for the life of this process (BAKR-8 Constraint 3)`
    );
  } else if (claimResult.status === "missing") {
    claimState = emptyStore();
  } else {
    claimState = claimResult.state;
  }

  const slotsResult = await loadSlots(deps.sessionSlotsPath);
  let sessionSlotsState: SessionSlotsState;
  let sessionSlotsDegraded = false;
  if (slotsResult.status === "malformed") {
    sessionSlotsDegraded = true;
    sessionSlotsState = emptySessionSlots();
    log(
      "error",
      `session slots store at "${deps.sessionSlotsPath}" is malformed: ${slotsResult.error} — starting/continuing degraded: restoring nothing, never writing to this file for the life of this process (same discipline as Constraint 3, applied to bakr's own store)`
    );
  } else if (slotsResult.status === "missing") {
    sessionSlotsState = emptySessionSlots();
  } else {
    sessionSlotsState = slotsResult.state;
  }

  return { claimState, sessionSlotsState, claimDegraded, sessionSlotsDegraded };
}

export interface ReconcileResult {
  readonly claimDegraded: boolean;
  readonly sessionSlotsDegraded: boolean;
  readonly restored: readonly { readonly key: ClaimKey; readonly sessionId: string }[];
  readonly skippedListingFailed: boolean;
}

/**
 * One reconcile cycle. Re-reads both stores fresh from disk on every call
 * (so a directory claimed, or a session put "on", after this process
 * started is picked up without a restart) UNLESS `prior` already carries a
 * degraded flag, in which case this function does not touch disk at all
 * this cycle beyond logging — once degraded, always degraded for this
 * process's life, exactly per Constraint 3, with no flip-flopping if the
 * file happens to parse cleanly on some later read.
 *
 * Exactly ONE `claude agents --json` listing per cycle (via
 * `listBackgroundSessions`), never one per claimed directory or per
 * on-session — required by the ticket's own scope.
 *
 * A listing failure (including Constraint 1's hardened systematic-failure
 * throw in spawn/parse.ts) makes the WHOLE cycle a no-op with a loud log —
 * never a relaunch, because "the listing failed" and "nothing is running"
 * must never be treated the same way (Constraint 1).
 *
 * Nothing here resolves, adopts, or restores a session by matching its
 * directory alone — every decision is keyed by the claim store's own keys
 * and the session-slots store's own recorded session ids, cross-checked
 * against the listing by session id (or, for in-flight launches, by the
 * short id `launch()` itself returned).
 */
export async function runReconcileCycle(prior: DaemonState, deps: DaemonDeps): Promise<ReconcileResult> {
  if (prior.claimDegraded || prior.sessionSlotsDegraded) {
    const parts: string[] = [];
    if (prior.claimDegraded) parts.push(`claim store "${deps.claimsPath}" is malformed`);
    if (prior.sessionSlotsDegraded) parts.push(`session slots store "${deps.sessionSlotsPath}" is malformed`);
    log("error", `reconcile skipped this cycle: ${parts.join("; ")} — this process will never write to the affected file(s); restart after repairing on disk`);
    return { claimDegraded: prior.claimDegraded, sessionSlotsDegraded: prior.sessionSlotsDegraded, restored: [], skippedListingFailed: false };
  }

  const { claimState, sessionSlotsState: loadedSlots, claimDegraded, sessionSlotsDegraded } = await loadStores(deps);
  if (claimDegraded || sessionSlotsDegraded) {
    return { claimDegraded, sessionSlotsDegraded, restored: [], skippedListingFailed: false };
  }

  let sessionSlotsState = loadedSlots;

  let sessions;
  try {
    sessions = await listBackgroundSessions({ runCommand: deps.runCommand });
  } catch (err) {
    log(
      "error",
      `reconcile skipped this cycle: \`claude agents --json\` listing failed: ${
        err instanceof Error ? err.message : String(err)
      } — never treated as "nothing running"; no restore is issued this cycle (BAKR-8 Constraint 1)`
    );
    return { claimDegraded: false, sessionSlotsDegraded: false, restored: [], skippedListingFailed: true };
  }

  // Resolve any launches (fresh or restore alike) still awaiting a listing
  // that reveals their real session id, using THIS cycle's listing rather
  // than issuing a second one.
  let slotsChangedThisPass = false;
  for (const pending of pendingLaunches(sessionSlotsState)) {
    if (pending.launchShortId === undefined) continue; // launch() has not returned yet this cycle
    const found = sessions.find((s) => s.id === pending.launchShortId);
    if (found === undefined) continue; // not listed yet — try again next cycle
    sessionSlotsState = resolveLaunch(sessionSlotsState, pending.launchShortId, found.sessionId);
    slotsChangedThisPass = true;
    log("info", `resolved launch attempt ${pending.attemptId} for "${pending.key}": short id ${pending.launchShortId} -> session ${found.sessionId}`);
  }

  for (const unresolved of unresolvedLaunches(sessionSlotsState)) {
    log(
      "error",
      `unresolved launch for "${unresolved.key}" (attempt ${unresolved.attemptId}, ${new Date(unresolved.attemptedAt).toISOString()}): ${
        unresolved.error
      } — possibly orphaned; never retried automatically, never adopted by directory (BAKR-8 Constraint 2)`
    );
  }

  if (slotsChangedThisPass) {
    await saveSlots(deps.sessionSlotsPath, sessionSlotsState);
  }

  const restored: { key: ClaimKey; sessionId: string }[] = [];
  for (const claimEntry of listClaims(claimState)) {
    const key = claimEntry.key;
    for (const sessionId of sessionsOn(sessionSlotsState, key)) {
      if (hasLaunchRecordFor(sessionSlotsState, key, sessionId)) {
        // A launch for exactly this session is already in flight (pending
        // resolution) or permanently unresolved (Constraint 2) — either
        // way, `onByKey` will not change until that record resolves, so
        // without this guard every cycle in between would look identical
        // to "never restored" and attempt a duplicate launch. Already
        // logged above (pendingLaunches / unresolvedLaunches loops).
        continue;
      }
      const entry = sessions.find((s) => s.sessionId === sessionId);
      const pidVerifiedAlive = entry?.pid !== undefined ? isPidAlive(entry.pid) : false;
      const verdict = decideLiveness(sessionId, entry, pidVerifiedAlive);

      if (verdict.status === "alive") continue;
      if (verdict.status === "not-verifiable") {
        log("warn", `"${key}": session ${sessionId} ${verdict.reason} — not restoring this cycle to avoid a duplicate; re-checked next cycle`);
        continue;
      }

      // verdict.status === "unknown": genuinely absent from a listing that
      // ITSELF succeeded this cycle (the listing-failed case already
      // returned above) — this is the one case Constraint 1 says "may lead
      // to a restore."
      const attemptId = deps.generateAttemptId();
      sessionSlotsState = beginLaunch(sessionSlotsState, key, sessionId, attemptId, deps.now());
      // Persisted BEFORE launch() is invoked — Constraint 2's "record the
      // intent to launch before invoking launch(), and persist it," so a
      // daemon crash mid-launch still leaves a durable trace.
      await saveSlots(deps.sessionSlotsPath, sessionSlotsState);

      const result = await launch(key, ["--resume", sessionId], { runCommand: deps.runCommand });
      if (result.ok) {
        sessionSlotsState = markLaunchStarted(sessionSlotsState, attemptId, result.id);
        log("info", `"${key}": restore launched for session ${sessionId} -> short id ${result.id}; awaiting a future listing to learn its rotated session id`);
        restored.push({ key, sessionId });
      } else {
        sessionSlotsState = markLaunchFailed(sessionSlotsState, attemptId, result.error);
        log(
          "error",
          `"${key}": restore launch for session ${sessionId} failed: ${result.error} — cannot distinguish "never detached" from "detached, then the wrapper failed"; treated as possibly orphaned, recorded as unresolved, never retried automatically (BAKR-8 Constraint 2)`
        );
      }
      await saveSlots(deps.sessionSlotsPath, sessionSlotsState);
    }
  }

  return { claimDegraded: false, sessionSlotsDegraded: false, restored, skippedListingFailed: false };
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
 * `options.signal` aborts — used by tests and by a clean programmatic
 * stop; the real systemd unit stops this process the ordinary way, by
 * signalling it, which `Restart=on-failure` then brings back per the unit
 * file). A single cycle throwing is caught and logged, never crashing the
 * daemon and never skipping the cycles after it — see this file's own
 * module comment for the candlestix pattern this mirrors.
 */
export async function runDaemonLoop(deps: DaemonDeps, options: DaemonLoopOptions): Promise<void> {
  let state: DaemonState = initialDaemonState();
  log(
    "info",
    `bakr daemon starting: claims="${deps.claimsPath}" session-slots="${deps.sessionSlotsPath}" interval=${options.intervalMs}ms`
  );
  while (options.signal?.aborted !== true) {
    try {
      const result = await runReconcileCycle(state, deps);
      state = { claimDegraded: result.claimDegraded, sessionSlotsDegraded: result.sessionSlotsDegraded };
    } catch (err) {
      log("error", `reconcile cycle threw and was caught, daemon continues: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    }
    await sleep(options.intervalMs, options.signal);
  }
  log("info", "bakr daemon loop stopped (abort signal)");
}
