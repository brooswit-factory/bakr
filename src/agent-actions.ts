// The action set itself (BAKR-21, implementing story BAKR-17): create, on,
// off, rename (and name), archive, unarchive, delete, list, and an
// attach-target query — plain functions over BAKR-16's agent record. NO CLI
// grammar, NO HTTP, NO UI, NO `process.argv` parsing, NO server (BAKR-3 and
// BAKR-4 own those surfaces). This file is the EFFECT layer: it calls the
// pure decisions in agent-lifecycle.ts, wraps each one's write in
// `withAgentStoreLock` (agent-store-io.ts), and drives `launch()` /
// `stopSession()` / `listBackgroundSessions()` (src/spawn) around it. R9:
// rules stay pure and separate from effects — nothing in agent-lifecycle.ts
// touches a lock, a session, or a clock; everything here that does is
// exactly one call site.
//
// THE STOP PATH (B9) — the reason this is the change most likely to break
// the host. `stopLiveSession` below is the ONE function `off`, `archive`
// and `delete` all call to stop a session, and it is the ONLY place in this
// file that constructs the map from an agent's own recorded `liveSessionId`
// to a listing entry: exact `sessionId` EQUALITY, never `cwd`, then
// `stopSession(entry.id, ...)`. This is deliberately NOT candlestix's own
// mechanism — at candlestix `f261c9bf`, `turnOff`/`archiveAgent` stop EVERY
// session found in the agent's directory, correct there only because
// candlestix mints each agent's own directory from an id it owns. Doing the
// same here would stop every agent sharing the directory, which is bakr's
// headline configuration. Never a cgroup, a scope, `systemctl --user stop`,
// or the shared `claude daemon run` singleton — `stopSession` (src/spawn/stop.ts)
// issues `claude stop <shortId>` and nothing else, and this file never
// constructs a stop invocation of its own.
//
// THE WRITE DISCIPLINE (B12, inherited from BAKR-16, stressed for the first
// time by this story): every mutation goes through `withAgentStoreLock`,
// which re-reads fresh state INSIDE the lock — the DECISION (agent-lifecycle.ts's
// call) is made inside that same hold as the write, never carried over from
// an earlier read. The lock is NEVER held across `launch()` or
// `stopSession()` — both run unlocked, between two separate lock holds,
// exactly like daemon.ts's own `decideAndBeginForAgent` / `recordLaunchOutcome`
// split. `off`/`archive`/`delete` all follow the SAME three-step shape this
// ticket's own steer asks for on `off`: record intent (lock 1) -> stop
// (unlocked) -> record outcome (lock 2) — the asymmetry is deliberate:
// crashing after the record leaves a stray, retryable session; crashing
// before it would leave the daemon free to relaunch a session this verb
// already decided to stop.
//
// THE LAUNCH-RECORD WEDGE (BAKR-17 comment, 2026-09-11, CONFIRMED at this
// checkout, and now epic ruling B13): a launch record left by a verb
// process that records `beginLaunch` and then dies before recording the
// outcome becomes PERMANENTLY unrecoverable once a daemon cycle's
// `promoteWedgedLaunches` marks it failed — `hasLaunchRecordFor` does not
// look at `error`, and `resolveLaunch` never removes a failed record. B13:
// "only an explicit operator action may clear a failed or given-up launch
// record; the reconcile loop never does... today those actions are `on`
// and `adopt`... the clearing must be reported in the action's typed
// result, never done silently." `on` below is that operator action here —
// see its own doc for the exact predicate it clears on (B13 point 2: a
// FAILED record only, never a genuinely in-flight one) and how it reports
// the clear (`wedgeCleared` in its typed result). It checks for a wedge
// REGARDLESS of whether the agent was off or already "on" — an already-on
// agent stuck on a wedged record (e.g. one left by `create`, which performs
// the identical kind of fresh launch) is exactly the second case B13 and
// the ticket's criterion 11 ask `on` to recover, not only the off -> on
// transition. `daemon.ts` never calls `clearFailedLaunchRecord` — B7 (the
// spawn-only reconcile loop) and B13 (the loop's give-up stays final) both
// stay intact; see `test/unit/daemon-no-stop-path.test.ts`'s sibling
// assertion in this story's own test suite.

import { emptyAgentStore, hasLaunchRecordFor, mintUniqueAgentId, agentsInDirectory, beginLaunch, clearFailedLaunchRecord, markLaunchStarted, markLaunchFailed, putAgent, removeAndRetireAgent, type AgentRecord, type AgentStoreState } from "./agent-model";
import { load, withAgentStoreLock } from "./agent-store-io";
import {
  decideArchive,
  decideAttachTarget,
  decideCreateName,
  decideDelete,
  decideOff,
  decideOn,
  decideRename,
  decideUnarchive,
  type ResolutionRefusal,
} from "./agent-lifecycle";
import { launch, listBackgroundSessions, stopSession, type RunCommand } from "./spawn";
import type { ClaimKey } from "./claim-key-resolve";

export interface AgentActionDeps {
  readonly agentsPath: string;
  readonly runCommand: RunCommand;
  readonly now: () => number;
  readonly generateAttemptId: () => string;
  readonly randomBytes: (byteLength: number) => Uint8Array;
  readonly acquireTimeoutMs?: number;
}

function lockOpts(deps: AgentActionDeps): { acquireTimeoutMs?: number } {
  const opts: { acquireTimeoutMs?: number } = {};
  if (deps.acquireTimeoutMs !== undefined) opts.acquireTimeoutMs = deps.acquireTimeoutMs;
  return opts;
}

/** Every verb returns this when `withAgentStoreLock` reports a malformed store — Constraint 3's discipline (never overwrite a malformed store) reaches this layer unchanged. */
export type StoreMalformed = { readonly ok: false; readonly reason: "store-malformed"; readonly message: string };

// --- The shared stop path (B9) ---------------------------------------------

export type StopOutcome =
  | { readonly kind: "nothing-to-stop" }
  | { readonly kind: "already-gone" }
  | { readonly kind: "stopped"; readonly shortId: string }
  | { readonly kind: "stop-failed"; readonly shortId: string; readonly error: string }
  | { readonly kind: "listing-failed"; readonly error: string };

/**
 * THE ONE FUNCTION `off`, `archive` and `delete` all call to stop a session
 * — see the module comment. `liveSessionId === undefined` means the agent
 * never held a live session (never launched, or already stopped) and there
 * is genuinely nothing to do — not a failure. A listing failure is reported
 * distinctly from "the session was not found in a listing that DID
 * succeed" (BAKR-17's Q2: a listing failure never means "nothing running"),
 * so a caller can tell the two apart rather than collapsing them.
 */
export async function stopLiveSession(deps: AgentActionDeps, liveSessionId: string | undefined): Promise<StopOutcome> {
  if (liveSessionId === undefined) {
    return { kind: "nothing-to-stop" };
  }
  let sessions;
  try {
    sessions = await listBackgroundSessions({ runCommand: deps.runCommand });
  } catch (err) {
    return { kind: "listing-failed", error: err instanceof Error ? err.message : String(err) };
  }
  const entry = sessions.find((s) => s.sessionId === liveSessionId);
  if (entry === undefined) {
    return { kind: "already-gone" };
  }
  const result = await stopSession(entry.id, { runCommand: deps.runCommand });
  return result.ok ? { kind: "stopped", shortId: entry.id } : { kind: "stop-failed", shortId: entry.id, error: result.error };
}

/** Second lock hold of the off/archive/delete three-step: clears `liveSessionId` ONLY when the stop was confirmed (stopped, or already gone) — a failed or unknown outcome leaves it as-is so the operator can retry. */
async function recordStopOutcome(deps: AgentActionDeps, agentId: string, stop: StopOutcome): Promise<void> {
  if (stop.kind !== "stopped" && stop.kind !== "already-gone") return;
  await withAgentStoreLock(
    deps.agentsPath,
    (current) => {
      const agent = current.agents[agentId];
      if (agent === undefined || agent.liveSessionId === undefined) return { state: current, result: undefined };
      return { state: putAgent(current, { ...agent, liveSessionId: undefined }), result: undefined };
    },
    lockOpts(deps)
  );
}

// --- create ------------------------------------------------------------

export type CreateResult =
  | StoreMalformed
  | { readonly ok: false; readonly reason: "empty" | "contains-at" | "reserved"; readonly message: string }
  | { readonly ok: false; readonly reason: "taken"; readonly message: string; readonly heldBy: AgentRecord }
  | { readonly ok: true; readonly agent: AgentRecord; readonly launch: { readonly ok: true; readonly launchShortId: string } | { readonly ok: false; readonly error: string } };

type CreateLockResult =
  | { readonly ok: false; readonly reason: "empty" | "contains-at" | "reserved"; readonly message: string }
  | { readonly ok: false; readonly reason: "taken"; readonly message: string; readonly heldBy: AgentRecord }
  | { readonly ok: true; readonly agent: AgentRecord; readonly attemptId: string };

/**
 * Mints a new id, writes an `on` agent with no session yet, and issues a
 * fresh launch — all inside the SAME lock hold as the decision (BAKR-17 Q1's
 * steer: "the verb launches", so the daemon's `hasLaunchRecordFor` guard
 * sees the record on its very next cycle and skips this agent rather than
 * double-launching it). B8: `claudeArgs` is empty — create passes no prompt
 * at all. Q3's answer: `sessionId` is NEVER known at return time —
 * `launch()` only ever returns a short id; the full session id comes only
 * from a later listing (see `list`, or the daemon's own next cycle
 * resolving it). The returned `launch.launchShortId` is honest about
 * exactly that much and no more.
 */
export async function create(deps: AgentActionDeps, directory: ClaimKey, name?: string): Promise<CreateResult> {
  const decided = await withAgentStoreLock<CreateLockResult>(
    deps.agentsPath,
    (current) => {
      const nameCheck = decideCreateName(current, directory, name);
      if (!nameCheck.ok) {
        return { state: current, result: nameCheck };
      }
      const id = mintUniqueAgentId(current, deps.randomBytes);
      const agent: AgentRecord = { id, name, directory, state: "on", createdAt: deps.now(), durableSessionId: undefined, liveSessionId: undefined };
      let next = putAgent(current, agent);
      const attemptId = deps.generateAttemptId();
      next = beginLaunch(next, id, directory, undefined, attemptId, deps.now());
      return { state: next, result: { ok: true, agent, attemptId } };
    },
    lockOpts(deps)
  );

  if (decided.status === "malformed") return { ok: false, reason: "store-malformed", message: decided.error };
  const result = decided.result;
  if (!result.ok) return result;

  const launchResult = await launch(directory, [], { runCommand: deps.runCommand });
  await withAgentStoreLock(
    deps.agentsPath,
    (current) => ({
      state: launchResult.ok ? markLaunchStarted(current, result.attemptId, launchResult.id) : markLaunchFailed(current, result.attemptId, launchResult.error),
      result: undefined,
    }),
    lockOpts(deps)
  );

  return { ok: true, agent: result.agent, launch: launchResult.ok ? { ok: true, launchShortId: launchResult.id } : { ok: false, error: launchResult.error } };
}

// --- on ------------------------------------------------------------------

export type OnResult =
  | StoreMalformed
  | ResolutionRefusal
  | { readonly ok: false; readonly reason: "archived"; readonly message: string; readonly agent: AgentRecord }
  | { readonly ok: true; readonly kind: "no-change" | "turn-on"; readonly agent: AgentRecord; readonly wedgeCleared: boolean; readonly launchIssued: boolean };

type OnLaunchPlan = { readonly kind: "in-flight" } | { readonly kind: "none" } | { readonly kind: "issue"; readonly attemptId: string; readonly priorSessionId: string | undefined };

type OnLockResult =
  | ResolutionRefusal
  | { readonly ok: false; readonly reason: "archived"; readonly message: string; readonly agent: AgentRecord }
  | { readonly ok: true; readonly kind: "no-change" | "turn-on"; readonly agent: AgentRecord; readonly wedgeCleared: boolean; readonly launch: OnLaunchPlan };

/**
 * B6: off -> on, refused while archived. B13 (epic ruling, 2026-09-11) — the
 * launch-record wedge (a crashed verb's intent record, PERMANENTLY
 * unremovable once a daemon cycle marks it failed — see the module comment)
 * is checked and, if failed, cleared HERE — deliberately and only here, an
 * explicit operator action, never something `daemon.ts` does, and ALWAYS
 * reported in the typed result (`wedgeCleared`), never silently. B13 point 2
 * (the epic's own sharp question): the predicate this clears on is "a
 * record exists for `(agentId, priorSessionId)` AND it is FAILED
 * (`clearFailedLaunchRecord` only ever removes one whose `error` is
 * already set)" — a genuinely in-flight (not-yet-failed) record is left
 * completely untouched and no duplicate launch is issued (this is what
 * keeps AC4 safe under concurrent callers).
 *
 * This check runs REGARDLESS of whether the agent was off or already on —
 * an already-"on" agent stuck on a wedged record (e.g. left by `create`,
 * which performs the identical kind of fresh launch) is exactly the second
 * case B13/criterion 11 asks `on` to recover, not only the off -> on
 * transition. `kind` still reports the LIFECYCLE diagonal honestly
 * ("no-change" when the agent was already on, "turn-on" when it
 * transitioned) — `wedgeCleared`/`launchIssued` are orthogonal facts about
 * the launch side effect, reported either way.
 *
 * B8 still binds absolutely: no prompt, ever. The id a restore resumes is
 * NOT hard-coded here — it comes from `decideOn`'s own call to
 * `agent-model.ts`'s `sessionIdToResume`, the one function/call site the
 * ticket's in-place correction (2026-09-11) requires, so adopting BAKR-23's
 * eventual rule for "which id do I resume" is a one-line change there, not
 * a hunt through this file. A never-launched agent's fresh launch passes
 * nothing (that function returns `undefined` for it).
 */
export async function on(deps: AgentActionDeps, directory: ClaimKey, ref: string): Promise<OnResult> {
  const decided = await withAgentStoreLock<OnLockResult>(
    deps.agentsPath,
    (current) => {
      const decision = decideOn(current, directory, ref);
      if (!decision.ok) {
        return { state: current, result: decision };
      }

      const kind = decision.wasOff ? ("turn-on" as const) : ("no-change" as const);
      const agentId = decision.agent.id;
      const priorSessionId = decision.priorSessionId;
      let next = decision.wasOff ? putAgent(current, decision.agent) : current;

      if (hasLaunchRecordFor(next, agentId, priorSessionId)) {
        const cleared = clearFailedLaunchRecord(next, agentId, priorSessionId);
        if (cleared === next) {
          // Genuinely in-flight (not failed) — never duplicate a live launch (AC4).
          return { state: next, result: { ok: true, kind, agent: decision.agent, wedgeCleared: false, launch: { kind: "in-flight" } } };
        }
        next = cleared;
        const attemptId = deps.generateAttemptId();
        next = beginLaunch(next, agentId, directory, priorSessionId, attemptId, deps.now());
        return { state: next, result: { ok: true, kind, agent: decision.agent, wedgeCleared: true, launch: { kind: "issue", attemptId, priorSessionId } } };
      }

      if (!decision.wasOff) {
        // Already on, no record at all — healthy or genuinely nothing to
        // do; ongoing liveness of an already-"on" agent stays the daemon's
        // own reconcile responsibility.
        return { state: next, result: { ok: true, kind, agent: decision.agent, wedgeCleared: false, launch: { kind: "none" } } };
      }

      const attemptId = deps.generateAttemptId();
      next = beginLaunch(next, agentId, directory, priorSessionId, attemptId, deps.now());
      return { state: next, result: { ok: true, kind, agent: decision.agent, wedgeCleared: false, launch: { kind: "issue", attemptId, priorSessionId } } };
    },
    lockOpts(deps)
  );

  if (decided.status === "malformed") return { ok: false, reason: "store-malformed", message: decided.error };
  const result = decided.result;
  if (!result.ok) return result;
  if (result.launch.kind !== "issue") {
    return { ok: true, kind: result.kind, agent: result.agent, wedgeCleared: result.wedgeCleared, launchIssued: false };
  }

  const { attemptId, priorSessionId } = result.launch;
  const claudeArgs = priorSessionId !== undefined ? ["--resume", priorSessionId] : [];
  const launchResult = await launch(directory, claudeArgs, { runCommand: deps.runCommand });
  await withAgentStoreLock(
    deps.agentsPath,
    (current) => ({
      state: launchResult.ok ? markLaunchStarted(current, attemptId, launchResult.id) : markLaunchFailed(current, attemptId, launchResult.error),
      result: undefined,
    }),
    lockOpts(deps)
  );

  return { ok: true, kind: result.kind, agent: result.agent, wedgeCleared: result.wedgeCleared, launchIssued: true };
}

// --- off -------------------------------------------------------------------

export type OffResult =
  | StoreMalformed
  | ResolutionRefusal
  | { readonly ok: false; readonly reason: "archived"; readonly message: string; readonly agent: AgentRecord }
  | { readonly ok: true; readonly kind: "no-change"; readonly agent: AgentRecord }
  | { readonly ok: true; readonly kind: "turned-off"; readonly agent: AgentRecord; readonly stop: StopOutcome };

type OffLockResult =
  | ResolutionRefusal
  | { readonly ok: false; readonly reason: "archived"; readonly message: string; readonly agent: AgentRecord }
  | { readonly ok: true; readonly kind: "no-change"; readonly agent: AgentRecord }
  | { readonly ok: true; readonly kind: "turn-off"; readonly agent: AgentRecord; readonly liveSessionId: string | undefined };

/** on -> off (B6), stopping the agent's own session (B9). See the module comment for the record-intent / stop-unlocked / record-outcome three-step and why that ordering is the asymmetric-safe one (BAKR-17 Q2). */
export async function off(deps: AgentActionDeps, directory: ClaimKey, ref: string): Promise<OffResult> {
  const recorded = await withAgentStoreLock<OffLockResult>(
    deps.agentsPath,
    (current) => {
      const decision = decideOff(current, directory, ref);
      if (!decision.ok || decision.kind === "no-change") {
        return { state: current, result: decision };
      }
      return { state: putAgent(current, decision.agent), result: decision };
    },
    lockOpts(deps)
  );
  if (recorded.status === "malformed") return { ok: false, reason: "store-malformed", message: recorded.error };
  const decision = recorded.result;
  if (!decision.ok || decision.kind === "no-change") return decision;

  const stop = await stopLiveSession(deps, decision.liveSessionId);
  await recordStopOutcome(deps, decision.agent.id, stop);
  return { ok: true, kind: "turned-off", agent: decision.agent, stop };
}

// --- archive -----------------------------------------------------------

export type ArchiveResult =
  | StoreMalformed
  | ResolutionRefusal
  | { readonly ok: true; readonly kind: "no-change"; readonly agent: AgentRecord }
  | { readonly ok: true; readonly kind: "archived"; readonly agent: AgentRecord; readonly stop: StopOutcome };

type ArchiveLockResult =
  | ResolutionRefusal
  | { readonly ok: true; readonly kind: "no-change"; readonly agent: AgentRecord }
  | { readonly ok: true; readonly kind: "archive"; readonly agent: AgentRecord; readonly liveSessionId: string | undefined };

/** {on, off} -> archived (B6), keeping the name, stopping the session if any. Identical stop path to `off` — `stopLiveSession` (see module comment / DoD item 2). */
export async function archive(deps: AgentActionDeps, directory: ClaimKey, ref: string): Promise<ArchiveResult> {
  const recorded = await withAgentStoreLock<ArchiveLockResult>(
    deps.agentsPath,
    (current) => {
      const decision = decideArchive(current, directory, ref);
      if (!decision.ok || decision.kind === "no-change") {
        return { state: current, result: decision };
      }
      return { state: putAgent(current, decision.agent), result: decision };
    },
    lockOpts(deps)
  );
  if (recorded.status === "malformed") return { ok: false, reason: "store-malformed", message: recorded.error };
  const decision = recorded.result;
  if (!decision.ok || decision.kind === "no-change") return decision;

  const stop = await stopLiveSession(deps, decision.liveSessionId);
  await recordStopOutcome(deps, decision.agent.id, stop);
  return { ok: true, kind: "archived", agent: decision.agent, stop };
}

// --- unarchive ---------------------------------------------------------

export type UnarchiveResult =
  | StoreMalformed
  | ResolutionRefusal
  | { readonly ok: false; readonly reason: "not-archived"; readonly message: string; readonly agent: AgentRecord }
  | { readonly ok: true; readonly agent: AgentRecord };

/** archived -> off, NEVER on (B6). No session-stopping — an archived agent already has none. */
export async function unarchive(deps: AgentActionDeps, directory: ClaimKey, ref: string): Promise<UnarchiveResult> {
  const decided = await withAgentStoreLock<UnarchiveResult>(
    deps.agentsPath,
    (current) => {
      const decision = decideUnarchive(current, directory, ref);
      if (!decision.ok) {
        return { state: current, result: decision };
      }
      return { state: putAgent(current, decision.agent), result: decision };
    },
    lockOpts(deps)
  );
  if (decided.status === "malformed") return { ok: false, reason: "store-malformed", message: decided.error };
  return decided.result;
}

// --- rename / name -------------------------------------------------------

export type RenameResult =
  | StoreMalformed
  | ResolutionRefusal
  | { readonly ok: false; readonly reason: "empty" | "contains-at" | "reserved"; readonly message: string }
  | { readonly ok: false; readonly reason: "taken"; readonly message: string; readonly heldBy: AgentRecord }
  | { readonly ok: true; readonly kind: "no-change"; readonly agent: AgentRecord }
  | { readonly ok: true; readonly kind: "renamed"; readonly agent: AgentRecord };

/** ONE function, not two (BAKR-17 doc) — `name` below is a plain alias, never a second implementation. Enforces per-directory uniqueness including archived holders (B4) and the reserved list (B5); moves nothing (R16). */
export async function rename(deps: AgentActionDeps, directory: ClaimKey, ref: string, newName: string): Promise<RenameResult> {
  const decided = await withAgentStoreLock<RenameResult>(
    deps.agentsPath,
    (current) => {
      const decision = decideRename(current, directory, ref, newName);
      if (!decision.ok || decision.kind === "no-change") {
        return { state: current, result: decision };
      }
      return { state: putAgent(current, decision.agent), result: decision };
    },
    lockOpts(deps)
  );
  if (decided.status === "malformed") return { ok: false, reason: "store-malformed", message: decided.error };
  return decided.result;
}

/** Alias for `rename`, for a caller naming a previously-unnamed agent — see `rename`'s own doc for why this is not a second implementation. */
export const name = rename;

// --- delete --------------------------------------------------------------

export type DeleteResult =
  | StoreMalformed
  | ResolutionRefusal
  | { readonly ok: true; readonly kind: "deleted"; readonly agentId: string; readonly stop: StopOutcome }
  | { readonly ok: true; readonly kind: "parked"; readonly agentId: string; readonly stop: StopOutcome; readonly message: string };

/**
 * Any state -> removed, id retired (its first writer), name freed (B6).
 * Stops the session first (identical stop path to `off`/`archive` — see
 * module comment / DoD item 2). Parks the agent in "archived" as its FIRST
 * lock hold, regardless of its starting state — this both records delete's
 * intent immediately (the same asymmetry `off` relies on: the daemon never
 * restores an archived agent, B7) and, if the stop cannot be confirmed,
 * gives the record somewhere honest to sit rather than being silently
 * removed on a guess. Only once the stop is CONFIRMED (stopped, or already
 * gone) is the record actually removed and the id retired; otherwise it
 * stays parked as archived and the operator can retry `delete`, which
 * attempts the stop again. `delete` never touches Claude Code's own
 * conversation storage — nothing in this function, or anywhere in this
 * file, references it — conversations stay exactly where Claude Code keeps
 * them; only bakr's own record of the agent is removed.
 */
export async function deleteAgent(deps: AgentActionDeps, directory: ClaimKey, ref: string): Promise<DeleteResult> {
  const recorded = await withAgentStoreLock<ResolutionRefusal | { readonly ok: true; readonly agent: AgentRecord; readonly liveSessionId: string | undefined }>(
    deps.agentsPath,
    (current) => {
      const decision = decideDelete(current, directory, ref);
      if (!decision.ok) {
        return { state: current, result: decision };
      }
      const parked: AgentRecord = { ...decision.agent, state: "archived" };
      return { state: putAgent(current, parked), result: decision };
    },
    lockOpts(deps)
  );
  if (recorded.status === "malformed") return { ok: false, reason: "store-malformed", message: recorded.error };
  const decision = recorded.result;
  if (!decision.ok) return decision;

  const stop = await stopLiveSession(deps, decision.liveSessionId);

  if (stop.kind !== "stopped" && stop.kind !== "already-gone") {
    return {
      ok: true,
      kind: "parked",
      agentId: decision.agent.id,
      stop,
      message: `could not confirm agent ${decision.agent.id}'s session was stopped (${stop.kind}) — parked as archived rather than deleted; retry "delete" to try again`,
    };
  }

  await withAgentStoreLock(
    deps.agentsPath,
    (current) => {
      if (!(decision.agent.id in current.agents)) return { state: current, result: undefined };
      return { state: removeAndRetireAgent(current, decision.agent.id), result: undefined };
    },
    lockOpts(deps)
  );

  return { ok: true, kind: "deleted", agentId: decision.agent.id, stop };
}

// --- list ------------------------------------------------------------------

export type ListResult = StoreMalformed | { readonly ok: true; readonly agents: readonly AgentRecord[] };

/** Directory-scoped, archived included (R10) — a CLI can hide archived agents and a webapp can have an Archived tab without a second query. Read-only: no lock needed (B12's lock exists to serialize mutations, not reads). */
export async function list(deps: AgentActionDeps, directory: ClaimKey): Promise<ListResult> {
  const loaded = await load(deps.agentsPath);
  if (loaded.status === "malformed") return { ok: false, reason: "store-malformed", message: loaded.error };
  const state: AgentStoreState = loaded.status === "loaded" ? loaded.state : emptyAgentStore();
  return { ok: true, agents: agentsInDirectory(state, directory) };
}

// --- attach target (R18: a query, never an act) ----------------------------

export type AttachTargetResult =
  | StoreMalformed
  | ResolutionRefusal
  | { readonly ok: false; readonly reason: "archived" | "off" | "not-yet-live"; readonly message: string; readonly agent: AgentRecord }
  | { readonly ok: true; readonly agent: AgentRecord; readonly liveSessionId: string; readonly durableSessionId: string };

/** Resolves `<id|name>` in `directory` and decides whether it is attachable NOW — never attaches, never touches a terminal, never starts anything. Read-only, same as `list`. */
export async function attachTarget(deps: AgentActionDeps, directory: ClaimKey, ref: string): Promise<AttachTargetResult> {
  const loaded = await load(deps.agentsPath);
  if (loaded.status === "malformed") return { ok: false, reason: "store-malformed", message: loaded.error };
  const state: AgentStoreState = loaded.status === "loaded" ? loaded.state : emptyAgentStore();
  return decideAttachTarget(state, directory, ref);
}
