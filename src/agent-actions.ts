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
// the clear (`launchWedgeCleared` in its typed result). It checks for a wedge
// REGARDLESS of whether the agent was off or already "on" — an already-on
// agent stuck on a wedged record (e.g. one left by `create`, which performs
// the identical kind of fresh launch) is exactly the second case B13 and
// the ticket's criterion 11 ask `on` to recover, not only the off -> on
// transition. `daemon.ts` never calls `clearFailedLaunchRecord` — B7 (the
// spawn-only reconcile loop) and B13 (the loop's give-up stays final) both
// stay intact; see `test/unit/daemon-no-stop-path.test.ts`'s sibling
// assertion in this story's own test suite.

import {
  emptyAgentStore,
  hasLaunchRecordFor,
  mintUniqueAgentId,
  agentsInDirectory,
  beginLaunch,
  clearFailedLaunchRecord,
  clearFailedForkFromRecordsForCurrentTarget,
  markLaunchStarted,
  markLaunchFailed,
  resolveRespawnAttempt,
  putAgent,
  removeAndRetireAgent,
  setAgentMcp,
  type AgentRecord,
  type AgentStoreState,
  type AttemptKey,
} from "./agent-model";
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
  resolveOrRefuse,
  type ResolutionRefusal,
} from "./agent-lifecycle";
import { launch, listBackgroundSessions, decideLiveness, isPidAlive, respawnSession, isRecognizedStaleCwdRefusal, isRecognizedMissingJobRefusal, stopSession, type RunCommand, type BackgroundSessionInfo } from "./spawn";
import { probeResumableTranscript, type TranscriptProbeDeps } from "./transcript-probe";
import { realTranscriptProbeDeps, realLaunchConfigDeps } from "./paths";
import { claudeLaunchArgs, hostDefaultDeclaration, provisionMcpFor, type LaunchConfigDeps, type McpServerDeclaration } from "./launch-config";
import type { ClaimKey } from "./claim-key-resolve";

export interface AgentActionDeps {
  readonly agentsPath: string;
  readonly runCommand: RunCommand;
  readonly now: () => number;
  readonly generateAttemptId: () => string;
  readonly randomBytes: (byteLength: number) => Uint8Array;
  readonly acquireTimeoutMs?: number;
  /** BAKR-22: read-only access to Claude Code's own `~/.claude/projects/` tree, for the never-spoken-to-then-moved check (`probeResumableTranscript`). Optional — defaults to the real filesystem (`realTranscriptProbeDeps`, paths.ts) — so every existing caller/test that never exercises the moved-directory escape needs no change. */
  readonly transcriptProbeDeps?: TranscriptProbeDeps;
  /** Which MCP servers a launched session must hear from, which declaration an agent without its own falls back to, and how to read a directory's `.mcp.json` and write its approval (launch-config.ts). Optional — defaults to the real filesystem and this host's own environment (`realLaunchConfigDeps`, paths.ts) — so every existing caller and test needs no change, and a host that configures nothing launches exactly as before. */
  readonly launchConfigDeps?: LaunchConfigDeps;
}

/** The agent's own MCP declaration, read fresh so a change made since the caller's lock hold still applies; `undefined` (this host's default) when it has none or the store cannot be read. */
async function declaredMcp(deps: AgentActionDeps, agentId: string): Promise<readonly McpServerDeclaration[] | undefined> {
  const loaded = await load(deps.agentsPath);
  return loaded.status === "loaded" ? loaded.state.agents[agentId]?.mcp : undefined;
}

/** Every `launch()` below carries this, after its MCP approval is written; `claude respawn` deliberately carries no flags (see launch-config.ts's module comment). */
const configuredLaunchArgs = async (deps: AgentActionDeps, directory: string, agentId: string): Promise<string[]> =>
  claudeLaunchArgs(directory, deps.launchConfigDeps ?? realLaunchConfigDeps, await declaredMcp(deps, agentId));

/** A respawn takes no flags, but still needs the agent's MCP approval in place before its process starts. */
const prepareRespawnFor = async (deps: AgentActionDeps, directory: string, agentId: string): Promise<void> =>
  provisionMcpFor(directory, deps.launchConfigDeps ?? realLaunchConfigDeps, await declaredMcp(deps, agentId));

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
export async function stopLiveSession(deps: AgentActionDeps, restoreSessionId: string | undefined): Promise<StopOutcome> {
  if (restoreSessionId === undefined) {
    return { kind: "nothing-to-stop" };
  }
  let sessions;
  try {
    sessions = await listBackgroundSessions({ runCommand: deps.runCommand });
  } catch (err) {
    return { kind: "listing-failed", error: err instanceof Error ? err.message : String(err) };
  }
  const entry = sessions.find((s) => s.sessionId === restoreSessionId);
  if (entry === undefined) {
    return { kind: "already-gone" };
  }
  const result = await stopSession(entry.id, { runCommand: deps.runCommand });
  return result.ok ? { kind: "stopped", shortId: entry.id } : { kind: "stop-failed", shortId: entry.id, error: result.error };
}

/**
 * BAKR-22: deliberately DOES NOT touch `restoreTarget` any more. The old
 * two-field model cleared `liveSessionId` here (leaving `durableSessionId`
 * alone) so a stopped session's stale id would not be mistaken for a live
 * one — necessary ONLY because that build's restore ignored `liveSessionId`
 * entirely and always resumed from `durableSessionId` regardless. Under
 * `respawn`, `restoreTarget` is not a liveness cache at all — a stopped
 * job's own short id is EXACTLY what a future `on` must pass to `respawn`
 * to bring it back with its conversation (BAKR-22 measured `claude respawn`
 * working correctly on a `claude stop`-stopped job). Clearing it here would
 * make the next `on` take the `fresh` `RestorePlan` branch and silently
 * discard the conversation — the very defect this story exists to fix,
 * reintroduced at the `off`/`archive`/`delete` seam instead of the daemon's.
 * So this function is kept (rather than deleted outright) only as the one
 * place documenting that decision; it performs no store mutation.
 */
async function recordStopOutcome(_deps: AgentActionDeps, _agentId: string, _stop: StopOutcome): Promise<void> {
  return;
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
export async function create(deps: AgentActionDeps, directory: ClaimKey, name?: string, mcp?: readonly McpServerDeclaration[]): Promise<CreateResult> {
  const decided = await withAgentStoreLock<CreateLockResult>(
    deps.agentsPath,
    (current) => {
      const nameCheck = decideCreateName(current, directory, name);
      if (!nameCheck.ok) {
        return { state: current, result: nameCheck };
      }
      const id = mintUniqueAgentId(current, deps.randomBytes);
      const agent: AgentRecord = { id, name, directory, state: "on", createdAt: deps.now(), birthSessionId: undefined, restoreTarget: undefined, ...(mcp === undefined ? {} : { mcp }) };
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

  const launchResult = await launch(directory, await configuredLaunchArgs(deps, directory, result.agent.id), { runCommand: deps.runCommand });
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

/**
 * BAKR-22: what `dispatchRespawn` actually did, reported rather than
 * swallowed — "respawned" is the ordinary path; the rest are all-recorded
 * escapes/refusals `on`'s own typed result surfaces via `recovery` below.
 * `abandonedSessionId`, when present, means the escape found NO transcript
 * to carry (positive evidence, per `probeResumableTranscript`) and chose a
 * bare fresh launch instead of a doomed fork — reported explicitly rather
 * than folded into an ordinary-looking success, because it discards a
 * session (even an empty one) and an operator must be able to see that
 * happened. `refused` also covers `could-not-tell` (the transcript probe
 * itself could not confirm either way) — the error message names the
 * reason so an operator can resolve it via `on`/`adopt` rather than bakr
 * guessing in either direction.
 */
export type RespawnOutcome =
  | { readonly kind: "respawned" }
  | { readonly kind: "moved-directory-escape"; readonly newShortId: string | undefined; readonly abandonedSessionId?: string }
  | { readonly kind: "missing-job-recovery"; readonly newShortId: string | undefined; readonly abandonedSessionId?: string }
  | { readonly kind: "refused"; readonly error: string };

export type OnResult =
  | StoreMalformed
  | ResolutionRefusal
  | { readonly ok: false; readonly reason: "archived"; readonly message: string; readonly agent: AgentRecord }
  | { readonly ok: false; readonly reason: "listing-failed"; readonly message: string }
  | { readonly ok: true; readonly kind: "no-change" | "turn-on"; readonly agent: AgentRecord; readonly launchWedgeCleared: boolean; readonly forkWedgeCleared: boolean; readonly launchIssued: boolean; readonly recovery?: RespawnOutcome };

/**
 * BAKR-22: `issue-respawn`/`issue-fresh` replace the old single `issue`
 * variant — `on` now needs to know WHICH mechanism to dispatch outside the
 * lock. `alive`/`not-verifiable` are new: the epic's explicit condition
 * that the liveness gate BAKR-22 built for `daemon.ts` applies here too —
 * `respawn` kills and restarts a live process (measured), so `on` must
 * never call it while `decideLiveness` reports `alive` or `not-verifiable`.
 * THERE IS NO "dead" VERDICT — `decideLiveness` produces exactly
 * `alive | not-verifiable | absent` (liveness.ts), and the impure
 * `checkLiveness` can additionally return `listing-failed`. `absent`'s own
 * doc comment is explicit that it is "not proof of death", only absence
 * from a listing that SUCCEEDED. `issue-respawn` is reachable ONLY on
 * `absent`, never on `listing-failed` — the same
 * weak link the old `--bg --resume` restore path already acted on, not a
 * stronger guarantee BAKR-22 introduces.
 */
type OnLaunchPlan =
  | { readonly kind: "in-flight" }
  | { readonly kind: "none" }
  | { readonly kind: "alive" }
  | { readonly kind: "not-verifiable"; readonly reason: string }
  | { readonly kind: "issue-fresh"; readonly attemptId: string }
  | { readonly kind: "issue-respawn"; readonly attemptId: string; readonly shortId: string; readonly restoreSessionId: string };

type OnLockResult =
  | ResolutionRefusal
  | { readonly ok: false; readonly reason: "archived"; readonly message: string; readonly agent: AgentRecord }
  | { readonly ok: true; readonly kind: "no-change" | "turn-on"; readonly agent: AgentRecord; readonly launchWedgeCleared: boolean; readonly forkWedgeCleared: boolean; readonly launch: OnLaunchPlan };

/**
 * B6: off -> on, refused while archived. B13 (epic ruling, 2026-09-11) — the
 * launch-record wedge (a crashed verb's intent record, PERMANENTLY
 * unremovable once a daemon cycle marks it failed — see the module comment)
 * is checked and, if failed, cleared HERE — deliberately and only here, an
 * explicit operator action, never something `daemon.ts` does, and ALWAYS
 * reported in the typed result (`launchWedgeCleared`), never silently. B13 point 2
 * (the epic's own sharp question): the predicate this clears on is "a
 * record exists for `(agentId, attemptKey(agent))` AND it is FAILED
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
 * transitioned) — the two clearing fields and `launchIssued` are orthogonal facts about
 * the launch side effect, reported either way.
 *
 * B8 still binds absolutely: no prompt, ever. The id a restore resumes is
 * NOT hard-coded here — it comes from `decideOn`'s own call to
 * `agent-model.ts`'s `planRestore`, which is THE single function that
 * answers "what do I restore, and how" for the whole tree: `decideOn`
 * (this file's `on`) and `daemon.ts`'s restore path are its only call
 * sites, so BAKR-23's rule landed inside that one function rather than in
 * a hunt across call sites. It returns a `RestorePlan`, not a bare id:
 * `{kind:"respawn", shortId}` when `agent.restoreTarget` is set, and
 * `{kind:"fresh"}` for a never-launched agent.
 *
 * (This comment named `sessionIdToResume` until the BAKR-18 merge. BAKR-21
 * and BAKR-18 had independently shipped identical seams under different
 * names, which git merged cleanly because nothing conflicted textually;
 * BAKR-2 required one name and `sessionToResume` won, being already on
 * `main` and already wired into the daemon. BAKR-23 then REPLACED that
 * seam outright with `planRestore`, which returns a plan rather than an
 * id — so the name settled above no longer exists. Worth recording because the
 * seam test scans COMMENT-STRIPPED source — by design, so the history can
 * be told — which means a stale comment like the old one is exactly the
 * thing that test structurally cannot catch, and it would have sent
 * BAKR-23 looking for a function that no longer exists.)
 */
export async function on(deps: AgentActionDeps, directory: ClaimKey, ref: string): Promise<OnResult> {
  // Fetched ONCE, outside any lock, before the decision — mirrors
  // daemon.ts's own "one listing per cycle" discipline. Every field access
  // below reads this same snapshot; nothing here issues a second listing.
  //
  // DELIBERATE, DISCLOSED TRADEOFF: fetched UNCONDITIONALLY, even for a
  // `fresh` plan (a never-launched agent) that has no session to check
  // liveness against at all and so never uses this listing. The
  // alternative — decide the plan first, inside the lock, and only fetch a
  // listing afterward for a `respawn` plan — would need a second lock pass
  // (the lock's own `mutate` is synchronous; it cannot itself await a
  // listing mid-decision) purely to skip one `claude agents --json` call
  // in the narrow window between `create()` and that agent's very first
  // launch ever resolving a session — the only shape a `fresh` plan can
  // have here (see `planRestore`). Every other call to `on()` — turning an
  // existing agent back on, or checking its wedge state — already has a
  // `respawn` plan and needs this listing regardless. Not revisited unless
  // that one extra call per rare `fresh` case turns out to matter.
  let sessions: readonly BackgroundSessionInfo[];
  try {
    sessions = await listBackgroundSessions({ runCommand: deps.runCommand });
  } catch (err) {
    return { ok: false, reason: "listing-failed", message: `cannot safely decide whether to respawn without a listing: ${err instanceof Error ? err.message : String(err)}` };
  }

  const decided = await withAgentStoreLock<OnLockResult>(
    deps.agentsPath,
    (current) => {
      const decision = decideOn(current, directory, ref);
      if (!decision.ok) {
        return { state: current, result: decision };
      }

      const kind = decision.wasOff ? ("turn-on" as const) : ("no-change" as const);
      const agentId = decision.agent.id;
      const plan = decision.plan;
      const attemptKey: AttemptKey | undefined = plan.kind === "respawn" ? { kind: "respawn", shortId: plan.shortId } : undefined;
      let next = decision.wasOff ? putAgent(current, decision.agent) : current;

      // BAKR-27 AC4: a FAILED `forkFrom`-keyed record (the escape's OWN
      // launch failing, not the respawn it was escaping) is never reachable
      // by the respawn/fresh-keyed wedge check just below — `planRestore`
      // never returns a `forkFrom` plan, so no `attemptKey` this function
      // computes can ever match one. Clear any such stray record for this
      // agent's CURRENT restore target FIRST, unconditionally, so a retried
      // escape below does not accumulate another one beside an old one no
      // verb could ever reach (see `clearFailedForkFromRecordsForCurrentTarget`'s
      // own doc). Independent of, and reported alongside, the primary
      // wedge-clear below.
      const forkCleared = clearFailedForkFromRecordsForCurrentTarget(next, agentId, decision.agent.restoreTarget?.sessionId);
      next = forkCleared.state;
      const forkWedgeCleared = forkCleared.clearedAttemptIds.length > 0;

      if (hasLaunchRecordFor(next, agentId, attemptKey)) {
        const cleared = clearFailedLaunchRecord(next, agentId, attemptKey);
        if (cleared === next) {
          // Genuinely in-flight (not failed) — never duplicate a live launch (AC4).
          return { state: next, result: { ok: true, kind, agent: decision.agent, launchWedgeCleared: false, forkWedgeCleared, launch: { kind: "in-flight" } } };
        }
        next = cleared;
        const attemptId = deps.generateAttemptId();
        next = beginLaunch(next, agentId, directory, attemptKey, attemptId, deps.now());
        const launchPlan: OnLaunchPlan =
          plan.kind === "fresh"
            ? { kind: "issue-fresh", attemptId }
            : { kind: "issue-respawn", attemptId, shortId: plan.shortId, restoreSessionId: (decision.agent.restoreTarget as { sessionId: string }).sessionId };
        return { state: next, result: { ok: true, kind, agent: decision.agent, launchWedgeCleared: true, forkWedgeCleared, launch: launchPlan } };
      }

      // BAKR-22: the liveness gate applies here too, not only in daemon.ts
      // — `respawn` kills and restarts a live process (measured), so `on`
      // must never call it while `decideLiveness` reports `alive` or
      // `not-verifiable`. Reachable ONLY on `absent`, never on
      // `listing-failed` — not a "dead" verdict (none exists), just
      // absence from a listing that succeeded; see
      // spawn/respawn.ts's own doc for why that is not a new weakness. A
      // `fresh` plan has no session to check liveness against at all
      // (there is nothing to be alive yet).
      if (plan.kind === "respawn") {
        const entry = sessions.find((s) => s.id === plan.shortId);
        const pidVerifiedAlive = entry?.pid !== undefined ? isPidAlive(entry.pid) : false;
        const verdict = decideLiveness(plan.shortId, entry, pidVerifiedAlive);
        if (verdict.status === "alive") {
          return { state: next, result: { ok: true, kind, agent: decision.agent, launchWedgeCleared: false, forkWedgeCleared, launch: { kind: "alive" } } };
        }
        if (verdict.status === "not-verifiable") {
          return { state: next, result: { ok: true, kind, agent: decision.agent, launchWedgeCleared: false, forkWedgeCleared, launch: { kind: "not-verifiable", reason: verdict.reason } } };
        }
      }

      if (!decision.wasOff) {
        // Already on, no record at all, and (for a respawn plan) verified
        // not alive — genuinely nothing pending; ongoing liveness of an
        // already-"on" agent otherwise stays the daemon's own reconcile
        // responsibility. Reachable for a `fresh` plan too (an agent whose
        // very first launch never resolved and has no wedge record either
        // — should not normally happen, but this is not the place to
        // fabricate a launch for it).
        if (plan.kind !== "respawn") {
          return { state: next, result: { ok: true, kind, agent: decision.agent, launchWedgeCleared: false, forkWedgeCleared, launch: { kind: "none" } } };
        }
      }

      const attemptId = deps.generateAttemptId();
      next = beginLaunch(next, agentId, directory, attemptKey, attemptId, deps.now());
      const launchPlan: OnLaunchPlan =
        plan.kind === "fresh"
          ? { kind: "issue-fresh", attemptId }
          : { kind: "issue-respawn", attemptId, shortId: plan.shortId, restoreSessionId: (decision.agent.restoreTarget as { sessionId: string }).sessionId };
      return { state: next, result: { ok: true, kind, agent: decision.agent, launchWedgeCleared: false, forkWedgeCleared, launch: launchPlan } };
    },
    lockOpts(deps)
  );

  if (decided.status === "malformed") return { ok: false, reason: "store-malformed", message: decided.error };
  const result = decided.result;
  if (!result.ok) return result;
  if (result.launch.kind === "issue-fresh") {
    const { attemptId } = result.launch;
    const launchResult = await launch(directory, await configuredLaunchArgs(deps, directory, result.agent.id), { runCommand: deps.runCommand });
    await withAgentStoreLock(
      deps.agentsPath,
      (current) => ({
        state: launchResult.ok ? markLaunchStarted(current, attemptId, launchResult.id) : markLaunchFailed(current, attemptId, launchResult.error),
        result: undefined,
      }),
      lockOpts(deps)
    );
    return { ok: true, kind: result.kind, agent: result.agent, launchWedgeCleared: result.launchWedgeCleared, forkWedgeCleared: result.forkWedgeCleared, launchIssued: true };
  }
  if (result.launch.kind === "issue-respawn") {
    const recovery = await dispatchRespawn(deps, directory, result.agent.id, result.launch.attemptId, result.launch.shortId, result.launch.restoreSessionId);
    // "respawned" is the ordinary, unremarkable path — `recovery` is
    // reported only for the three shapes worth an operator's attention
    // (an escape happened, or the attempt was refused outright), never
    // silently, per B13's own "clearing/escaping must be reported" spirit.
    return recovery.kind === "respawned"
      ? { ok: true, kind: result.kind, agent: result.agent, launchWedgeCleared: result.launchWedgeCleared, forkWedgeCleared: result.forkWedgeCleared, launchIssued: true }
      : { ok: true, kind: result.kind, agent: result.agent, launchWedgeCleared: result.launchWedgeCleared, forkWedgeCleared: result.forkWedgeCleared, launchIssued: true, recovery };
  }

  return { ok: true, kind: result.kind, agent: result.agent, launchWedgeCleared: result.launchWedgeCleared, forkWedgeCleared: result.forkWedgeCleared, launchIssued: false };
}

/** What `forkFromCurrentTarget` actually did — three-valued, matching `probeResumableTranscript`'s own discipline (see that module's doc for why a boolean would be dangerous here). */
type ForkFromEscapeResult =
  | { readonly outcome: "forked"; readonly newShortId: string | undefined }
  | { readonly outcome: "fresh-abandoned"; readonly newShortId: string | undefined }
  | { readonly outcome: "could-not-determine"; readonly reason: string };

/**
 * The shared escape: mints a replacement session for `restoreSessionId`.
 * BAKR-22 EPIC CORRECTION: routes on `probeResumableTranscript`'s THREE
 * outcomes, never a boolean — a false "no transcript" would make bakr
 * choose `fresh` and PERMANENTLY, SILENTLY abandon a real conversation,
 * which is worse than the phantom-fork failure this mechanism exists to
 * avoid (the phantom at least fails LOUDLY on first prompt).
 * - `has-transcript` -> the real `--fork-session` escape, carrying the
 *   conversation.
 * - `no-transcript` -> a bare fresh launch — but ONLY on POSITIVE evidence
 *   that there is nothing to lose, and the caller (`dispatchRespawn`
 *   below) is responsible for reporting this loudly, naming the abandoned
 *   session id, never silently.
 * - `could-not-tell` -> NEITHER. No new launch attempt is made at all;
 *   only the original failure is recorded, leaving the agent wedged for
 *   an operator to resolve via `on`/`adopt` once the layout question is
 *   settled. Guessing in either direction here is the exact mistake this
 *   correction exists to prevent.
 *
 * Records the original failed attempt (and, when it proceeds, the new
 * escape attempt) — both keyed so B13 holds (see `dispatchRespawn`'s own
 * doc). Shared by BOTH the stale-cwd escape (also reachable from the
 * daemon loop) and the operator-only missing-job recovery below (reachable
 * ONLY from `on`).
 */
async function forkFromCurrentTarget(deps: AgentActionDeps, directory: ClaimKey, agentId: string, failedAttemptId: string, failedError: string, restoreSessionId: string): Promise<ForkFromEscapeResult> {
  const probe = await probeResumableTranscript(restoreSessionId, deps.transcriptProbeDeps ?? realTranscriptProbeDeps);

  if (probe.status === "could-not-tell") {
    await withAgentStoreLock(deps.agentsPath, (current) => ({ state: markLaunchFailed(current, failedAttemptId, failedError), result: undefined }), lockOpts(deps));
    return { outcome: "could-not-determine", reason: probe.reason };
  }

  const canForkFrom = probe.status === "has-transcript";
  const configured = await configuredLaunchArgs(deps, directory, agentId);
  const forkResult = canForkFrom
    ? await launch(directory, ["--resume", restoreSessionId, "--fork-session", ...configured], { runCommand: deps.runCommand })
    : await launch(directory, configured, { runCommand: deps.runCommand });
  await withAgentStoreLock(
    deps.agentsPath,
    (current) => {
      let next = markLaunchFailed(current, failedAttemptId, failedError);
      const forkAttemptId = deps.generateAttemptId();
      const forkKey: AttemptKey = { kind: "forkFrom", sessionId: restoreSessionId };
      next = beginLaunch(next, agentId, directory, forkKey, forkAttemptId, deps.now());
      next = forkResult.ok ? markLaunchStarted(next, forkAttemptId, forkResult.id) : markLaunchFailed(next, forkAttemptId, forkResult.error);
      return { state: next, result: undefined };
    },
    lockOpts(deps)
  );
  const newShortId = forkResult.ok ? forkResult.id : undefined;
  return canForkFrom ? { outcome: "forked", newShortId } : { outcome: "fresh-abandoned", newShortId };
}

/**
 * Dispatches ONE `respawn` attempt outside the lock (R-F: never hold the
 * lock across a spawn), and records the outcome in a second, separate
 * locked mutation — the same "decide -> act unlocked -> record locked"
 * three-step every launch path in this tree follows.
 *
 * BAKR-22's stale-cwd escape: `respawn`'s ONE recognised failure shape
 * (`isRecognizedStaleCwdRefusal`) transitions to `forkFrom` — a real
 * `launch()` with `--fork-session` from the agent's CURRENT directory,
 * resuming its CURRENT `restoreTarget.sessionId` (never `birthSessionId` —
 * see `resolveLaunch`'s own doc for why forking from anything but the
 * current target would reintroduce this ticket's rewind bug on a second
 * move).
 *
 * BAKR-22's missing-job recovery — OPERATOR-ONLY, reachable ONLY here,
 * NEVER from daemon.ts: `respawn` also refuses "No job matching" when
 * claude's own job entry is simply gone (not a stale-cwd shape at all —
 * a different, less-verified claim about WHY it is missing). B7/B13 keep
 * the unattended loop's give-up final and spawn-only; this is the
 * explicit, REPORTED operator recovery the epic asked for — `on` is
 * exactly the kind of explicit operator action B13 already carves out an
 * exception for (alongside `adopt`), so extending it to attempt the same
 * `forkFrom` escape here, and reporting it (`recovery` in `OnResult`), is
 * consistent with that exception rather than a new one.
 *
 * ANY OTHER non-zero result — from either failure category — is a typed
 * refusal that leaves the original `respawn` launch record failed and
 * NEVER falls through to `forkFrom`: an unrecognised failure could mean
 * anything, and forking on a guess would abandon a live conversation and
 * mint a new one.
 */
async function dispatchRespawn(deps: AgentActionDeps, directory: ClaimKey, agentId: string, attemptId: string, shortId: string, restoreSessionId: string): Promise<RespawnOutcome> {
  await prepareRespawnFor(deps, directory, agentId);
  const result = await respawnSession(shortId, { runCommand: deps.runCommand });
  if (result.ok) {
    await withAgentStoreLock(deps.agentsPath, (current) => ({ state: resolveRespawnAttempt(current, attemptId), result: undefined }), lockOpts(deps));
    return { kind: "respawned" };
  }

  if (isRecognizedStaleCwdRefusal(result.error)) {
    const escape = await forkFromCurrentTarget(deps, directory, agentId, attemptId, result.error, restoreSessionId);
    if (escape.outcome === "could-not-determine") {
      return { kind: "refused", error: `could not determine whether session ${restoreSessionId} has a resumable transcript (${escape.reason}) — refusing rather than guessing in either direction (forking a doomed fork, or silently abandoning a real conversation); resolve with on/adopt once the layout question is settled` };
    }
    return escape.outcome === "fresh-abandoned"
      ? { kind: "moved-directory-escape", newShortId: escape.newShortId, abandonedSessionId: restoreSessionId }
      : { kind: "moved-directory-escape", newShortId: escape.newShortId };
  }

  if (isRecognizedMissingJobRefusal(result.error)) {
    const escape = await forkFromCurrentTarget(deps, directory, agentId, attemptId, result.error, restoreSessionId);
    if (escape.outcome === "could-not-determine") {
      return { kind: "refused", error: `could not determine whether session ${restoreSessionId} has a resumable transcript (${escape.reason}) — refusing rather than guessing in either direction; resolve with on/adopt once the layout question is settled` };
    }
    return escape.outcome === "fresh-abandoned"
      ? { kind: "missing-job-recovery", newShortId: escape.newShortId, abandonedSessionId: restoreSessionId }
      : { kind: "missing-job-recovery", newShortId: escape.newShortId };
  }

  await withAgentStoreLock(deps.agentsPath, (current) => ({ state: markLaunchFailed(current, attemptId, result.error), result: undefined }), lockOpts(deps));
  return { kind: "refused", error: result.error };
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
  | { readonly ok: true; readonly kind: "turn-off"; readonly agent: AgentRecord; readonly restoreSessionId: string | undefined };

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

  const stop = await stopLiveSession(deps, decision.restoreSessionId);
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
  | { readonly ok: true; readonly kind: "archive"; readonly agent: AgentRecord; readonly restoreSessionId: string | undefined };

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

  const stop = await stopLiveSession(deps, decision.restoreSessionId);
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

// --- mcp -------------------------------------------------------------------

export type McpResult =
  | StoreMalformed
  | ResolutionRefusal
  | { readonly ok: true; readonly agent: AgentRecord; readonly changed: boolean; readonly hostDefault: readonly McpServerDeclaration[] };

/**
 * Shows (`mcp` omitted) or replaces an agent's MCP declaration; `null`
 * returns it to this host's default. A change writes the vendor approval at
 * once, so it is in place before the agent's next start — which is when a
 * running session reads it. Never starts or stops anything.
 */
export async function mcp(deps: AgentActionDeps, directory: ClaimKey, ref: string, declaration?: readonly McpServerDeclaration[] | null): Promise<McpResult> {
  const launchDeps = deps.launchConfigDeps ?? realLaunchConfigDeps;
  const hostDefault = hostDefaultDeclaration(launchDeps);
  if (declaration === undefined) {
    const loaded = await load(deps.agentsPath);
    if (loaded.status === "malformed") return { ok: false, reason: "store-malformed", message: loaded.error };
    const resolved = resolveOrRefuse(loaded.status === "loaded" ? loaded.state : emptyAgentStore(), directory, ref);
    return resolved.ok ? { ok: true, agent: resolved.agent, changed: false, hostDefault } : resolved;
  }
  const next = declaration ?? undefined;
  const decided = await withAgentStoreLock<ResolutionRefusal | { readonly ok: true; readonly agent: AgentRecord; readonly changed: boolean }>(
    deps.agentsPath,
    (current) => {
      const resolved = resolveOrRefuse(current, directory, ref);
      if (!resolved.ok) return { state: current, result: resolved };
      const changed = JSON.stringify(resolved.agent.mcp) !== JSON.stringify(next);
      const updated = setAgentMcp(current, resolved.agent.id, next);
      return { state: changed ? updated : current, result: { ok: true, agent: updated.agents[resolved.agent.id]!, changed } };
    },
    lockOpts(deps)
  );
  if (decided.status === "malformed") return { ok: false, reason: "store-malformed", message: decided.error };
  const result = decided.result;
  if (!result.ok) return result;
  await provisionMcpFor(result.agent.directory, launchDeps, result.agent.mcp);
  return { ...result, hostDefault };
}

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
  const recorded = await withAgentStoreLock<ResolutionRefusal | { readonly ok: true; readonly agent: AgentRecord; readonly restoreSessionId: string | undefined }>(
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

  const stop = await stopLiveSession(deps, decision.restoreSessionId);

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
  | { readonly ok: true; readonly agent: AgentRecord; readonly restoreSessionId: string; readonly birthSessionId: string };

/** Resolves `<id|name>` in `directory` and decides whether it is attachable NOW — never attaches, never touches a terminal, never starts anything. Read-only, same as `list`. */
export async function attachTarget(deps: AgentActionDeps, directory: ClaimKey, ref: string): Promise<AttachTargetResult> {
  const loaded = await load(deps.agentsPath);
  if (loaded.status === "malformed") return { ok: false, reason: "store-malformed", message: loaded.error };
  const state: AgentStoreState = loaded.status === "loaded" ? loaded.state : emptyAgentStore();
  return decideAttachTarget(state, directory, ref);
}
