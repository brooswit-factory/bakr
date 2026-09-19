// The pure transition table for the action set (BAKR-21, implementing story
// BAKR-17): given a store snapshot and a request, decides what SHOULD
// happen, and hands back the already-updated `AgentRecord` for the caller
// to `putAgent` — but performs no I/O, no locking, and no spawning itself
// (R9: rules stay pure and separate from effects). `src/agent-actions.ts` is
// the effect layer that calls into this file, wraps each decision in
// `withAgentStoreLock`, and drives `launch()`/`stopSession()` around it.
//
// Taken from candlestix (BAKR-2's own instruction: "take candlestix's
// transition rules, typed outcomes and structure; not its stop path") —
// the shape of a typed refusal carrying a verbatim message (R8), and a
// typed "no change" success on the diagonal (CNDLX-18's refinement) so a
// surface can tell "already off" apart from both "turned off" and
// "refused". Every transition here is a pure function of
// (state, scope, ref, ...) -> a decision; nothing here ever touches a
// session, a clock, or the filesystem.
//
// B2 (restated because this file leans on it constantly): `directory` is an
// agent's ATTRIBUTE, never its identity — an id is. `resolveAgent` (imported
// from agent-model.ts) is the only place a `ref` is turned into an agent.
// BAKR-34/BAKR-42 R4 removed `found-elsewhere` entirely: resolution is
// global now (an id or a name resolves independent of any caller cwd), so
// there is no longer a "found, but scoped elsewhere" outcome to distinguish
// from `not-found` — see `ResolutionRefusal` and `resolveOrRefuse` below,
// which only ever produce `not-found`, `ambiguous` (R6) or `renamed` (R8).

import type { ClaimKey } from "./claim-key-resolve";
import { type AgentRecord, type AgentStoreState, type RefClassification, type RestorePlan, planRestore, resolveAgent } from "./agent-model";

// --- Shared resolution (every verb starts here) ---------------------------

/** The raw ref text a refusal message can show verbatim — an id, a real-path spelling, or a name; whichever the caller classified. */
function refText(classification: RefClassification): string {
  return classification.kind === "directory" ? classification.directory : classification.ref;
}

export type ResolutionRefusal =
  | { readonly ok: false; readonly reason: "not-found"; readonly message: string }
  /** R6: a directory (reached by name or by real path) held by more than one non-archived agent — a legacy store already violating one-per-directory, kept loadable rather than bricked. */
  | { readonly ok: false; readonly reason: "ambiguous"; readonly message: string; readonly agentIds: readonly string[] }
  /** R8: `ref` matched only a legacy stored `name`; nothing was changed. `derivedName` is present unless that agent's own directory is itself ambiguous. */
  | { readonly ok: false; readonly reason: "renamed"; readonly message: string; readonly derivedName?: string };

export type Resolved = { readonly ok: true; readonly agent: AgentRecord } | ResolutionRefusal;

/**
 * The one entry point every decision function below calls first. R4:
 * resolution no longer takes a directory scope — an id resolves from any
 * cwd, and a name resolves against the current global derived-name set
 * (agent-name.ts); `found-elsewhere` no longer exists because there is no
 * scope left to be "elsewhere" from. `classification` is `RefClassification`
 * (agent-model.ts) — the caller has already made R2's lexical id/real-path/name
 * call, and, for a real-path ref, already resolved it to a `ClaimKey`
 * (symlink-aware resolution is impure and never happens in this file).
 */
export function resolveOrRefuse(state: AgentStoreState, classification: RefClassification): Resolved {
  const outcome = resolveAgent(state, classification);
  if (outcome.outcome === "not-found") {
    const ref = refText(classification);
    const retiredNote = classification.kind === "id" && state.retiredIds.includes(ref) ? " (this id was deleted — ids are retired on delete and never reused)" : "";
    return { ok: false, reason: "not-found", message: `no agent "${ref}" found${retiredNote}` };
  }
  if (outcome.outcome === "ambiguous") {
    const ids = outcome.agents.map((a) => a.id);
    return {
      ok: false,
      reason: "ambiguous",
      message: `"${refText(classification)}" names a directory held by more than one non-archived agent (${ids.join(", ")}) — archive one, or act on a specific agent by its @id`,
      agentIds: ids,
    };
  }
  if (outcome.outcome === "renamed") {
    const hint = outcome.derivedName === undefined
      ? `its directory is shared by another agent (ambiguous) — use its @id (${outcome.agent.id}) instead`
      : `use "${outcome.derivedName}" instead (or its @id, ${outcome.agent.id})`;
    return {
      ok: false,
      reason: "renamed",
      message: `"${refText(classification)}" was a custom name; an agent's name is now derived from its directory — ${hint}`,
      ...(outcome.derivedName === undefined ? {} : { derivedName: outcome.derivedName }),
    };
  }
  return { ok: true, agent: outcome.agent };
}

// --- create: one non-archived agent per directory (R6) ---------------------

export type CreateDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "directory-occupied"; readonly message: string; readonly agent: AgentRecord };

/** R6: `create` (and `bakr <real path>` when it would create) refuses a directory that already holds a non-archived agent; an archived one there does not block it. */
export function decideCreate(state: AgentStoreState, directory: ClaimKey): CreateDecision {
  const existing = Object.values(state.agents).find((a) => a.directory === directory && a.state !== "archived");
  if (existing !== undefined) {
    return {
      ok: false,
      reason: "directory-occupied",
      message: `a non-archived agent already exists for this directory (${existing.id}) — archive it first, or act on it directly`,
      agent: existing,
    };
  }
  return { ok: true };
}

// --- on: off -> on (B6). Refused while archived — never a silent unarchive. -

export type OnDecision =
  | ResolutionRefusal
  | { readonly ok: false; readonly reason: "archived"; readonly message: string; readonly agent: AgentRecord }
  | { readonly ok: true; readonly agent: AgentRecord; readonly wasOff: boolean; readonly plan: RestorePlan };

/**
 * Resolution and the LIFECYCLE half of `on` only — refuse archived,
 * transition off -> on, no-op the state field when already on. Deliberately
 * does NOT decide whether a launch is issued: that is inseparable from the
 * launch-record wedge check (B13, epic ruling 2026-09-11), which needs
 * `hasLaunchRecordFor`/`clearFailedLaunchRecord` (agent-model.ts) — kept in
 * `agent-actions.ts`'s `on` so this function stays pure. `wasOff` tells the
 * caller whether a real transition happened (for the "no-change" vs
 * "turn-on" diagonal); the launch record is keyed by `attemptKey(agent)`,
 * derived from `planRestore(agent)` (agent-model.ts) — the one call site
 * the ticket's in-place correction requires — computed
 * here EITHER WAY, because B13's wedge-clearing applies to an already-"on"
 * agent too (an agent stuck "on" with a wedged fresh-launch record, e.g.
 * from `create` crashing, needs the identical check `on` performs for the
 * off -> on case — see the module comment in agent-actions.ts).
 */
export function decideOn(state: AgentStoreState, classification: RefClassification): OnDecision {
  const resolved = resolveOrRefuse(state, classification);
  if (!resolved.ok) return resolved;
  const agent = resolved.agent;

  if (agent.state === "archived") {
    return {
      ok: false,
      reason: "archived",
      message: `agent ${agent.id} is archived — "on" is refused rather than silently unarchiving it; call "unarchive" first (it lands on off, never on), then "on"`,
      agent,
    };
  }

  const wasOff = agent.state === "off";
  const plan = planRestore(agent);
  const nextAgent: AgentRecord = wasOff ? { ...agent, state: "on" } : agent;
  return { ok: true, agent: nextAgent, wasOff, plan };
}

// --- off: on -> off (B6), and the caller stops `restoreTarget` -------------

export type OffDecision =
  | ResolutionRefusal
  | { readonly ok: false; readonly reason: "archived"; readonly message: string; readonly agent: AgentRecord }
  | { readonly ok: true; readonly kind: "no-change"; readonly agent: AgentRecord }
  | { readonly ok: true; readonly kind: "turn-off"; readonly agent: AgentRecord; readonly restoreSessionId: string | undefined };

/**
 * Archived is refused rather than treated as an "off" no-change — a
 * deliberate interpretation call, symmetric with on-while-archived: the
 * only sanctioned archived -> off transition is the explicit `unarchive`
 * verb (B6: "unarchive lands on off, never on"). Letting a plain `off`
 * silently do the same thing would give archived -> off two unannounced
 * doors instead of one. Arguable with evidence, per this epic's own
 * standing invitation — the ticket does not enumerate this refusal by name
 * the way it does on-while-archived, so it is a choice, not a re-derivation
 * of something already specified.
 */
export function decideOff(state: AgentStoreState, classification: RefClassification): OffDecision {
  const resolved = resolveOrRefuse(state, classification);
  if (!resolved.ok) return resolved;
  const agent = resolved.agent;

  if (agent.state === "archived") {
    return {
      ok: false,
      reason: "archived",
      message: `agent ${agent.id} is archived, not on — an archived agent already has no live session, and the only sanctioned way back to "off" is "unarchive"`,
      agent,
    };
  }
  if (agent.state === "off") {
    return { ok: true, kind: "no-change", agent };
  }
  return { ok: true, kind: "turn-off", agent: { ...agent, state: "off" }, restoreSessionId: agent.restoreTarget?.sessionId };
}

// --- archive: {on, off} -> archived, keeping the name (B6) -----------------

export type ArchiveDecision =
  | ResolutionRefusal
  | { readonly ok: true; readonly kind: "no-change"; readonly agent: AgentRecord }
  | { readonly ok: true; readonly kind: "archive"; readonly agent: AgentRecord; readonly restoreSessionId: string | undefined };

export function decideArchive(state: AgentStoreState, classification: RefClassification): ArchiveDecision {
  const resolved = resolveOrRefuse(state, classification);
  if (!resolved.ok) return resolved;
  const agent = resolved.agent;

  if (agent.state === "archived") {
    return { ok: true, kind: "no-change", agent };
  }
  // `name` is left untouched (B6: archived agents keep their name, so a
  // later unarchive can never collide).
  return { ok: true, kind: "archive", agent: { ...agent, state: "archived" }, restoreSessionId: agent.restoreTarget?.sessionId };
}

// --- unarchive: archived -> off, NEVER on (B6) ------------------------------

export type UnarchiveDecision =
  | ResolutionRefusal
  | { readonly ok: false; readonly reason: "not-archived"; readonly message: string; readonly agent: AgentRecord }
  | { readonly ok: true; readonly agent: AgentRecord };

export function decideUnarchive(state: AgentStoreState, classification: RefClassification): UnarchiveDecision {
  const resolved = resolveOrRefuse(state, classification);
  if (!resolved.ok) return resolved;
  const agent = resolved.agent;

  if (agent.state !== "archived") {
    return {
      ok: false,
      reason: "not-archived",
      message: `agent ${agent.id} is not archived (it is "${agent.state}") — "unarchive" only applies to an archived agent`,
      agent,
    };
  }
  return { ok: true, agent: { ...agent, state: "off" } };
}

// --- name / rename: RETIRED (R9) --------------------------------------------
// Custom names are gone; an agent's name is always derived from its
// directory (R1/R3). See agent-model.ts's module comment and the R8 rename
// hint in `resolveOrRefuse` above for what a stale custom name now does.

// --- delete: any state -> removed, id retired, name freed (B6) -------------

export type DeleteDecision = ResolutionRefusal | { readonly ok: true; readonly agent: AgentRecord; readonly restoreSessionId: string | undefined };

/**
 * No "no-change" diagonal: a second `delete` of the same ref resolves
 * `not-found` on its own (the record is genuinely gone after the first),
 * which is both correct and requires no special-casing here. The actual
 * removal (id retired, record removed from `agents`) is
 * `agent-model.ts`'s `removeAndRetireAgent` — this function only decides
 * THAT the delete is permitted and what session (if any) must be stopped
 * first.
 */
export function decideDelete(state: AgentStoreState, classification: RefClassification): DeleteDecision {
  const resolved = resolveOrRefuse(state, classification);
  if (!resolved.ok) return resolved;
  return { ok: true, agent: resolved.agent, restoreSessionId: resolved.agent.restoreTarget?.sessionId };
}

// --- attach target: a query, never an act (R18) ----------------------------

export type AttachDecision =
  | ResolutionRefusal
  | { readonly ok: false; readonly reason: "archived"; readonly message: string; readonly agent: AgentRecord }
  | { readonly ok: false; readonly reason: "off"; readonly message: string; readonly agent: AgentRecord }
  | { readonly ok: false; readonly reason: "not-yet-live"; readonly message: string; readonly agent: AgentRecord }
  | { readonly ok: true; readonly agent: AgentRecord; readonly restoreSessionId: string; readonly birthSessionId: string };

/**
 * Resolves an attach target and decides whether it is attachable NOW — it
 * never attaches, opens a terminal, or touches a session itself (R18). An
 * `off` agent is refused with a message saying turning it on is the way,
 * never silently started; `archived` is refused for the same reason
 * on-while-archived is. A THIRD case this file adds, not named explicitly
 * in the epic's list: an `on` agent whose fresh launch has not yet resolved
 * a session at all (`restoreTarget`/`birthSessionId` both still
 * `undefined`) — distinct from both `off` and a genuine live target, so a
 * caller is told to retry shortly rather than being handed a session id
 * that does not exist yet.
 */
export function decideAttachTarget(state: AgentStoreState, classification: RefClassification): AttachDecision {
  const resolved = resolveOrRefuse(state, classification);
  if (!resolved.ok) return resolved;
  const agent = resolved.agent;

  if (agent.state === "archived") {
    return { ok: false, reason: "archived", message: `agent ${agent.id} is archived and cannot be attached to`, agent };
  }
  if (agent.state === "off") {
    return { ok: false, reason: "off", message: `agent ${agent.id} is off — turning it on is the way to attach to it; "attach" never silently starts an agent`, agent };
  }
  if (agent.restoreTarget === undefined || agent.birthSessionId === undefined) {
    return { ok: false, reason: "not-yet-live", message: `agent ${agent.id} is on, but its launch has not resolved a session yet — try again shortly`, agent };
  }
  return { ok: true, agent, restoreSessionId: agent.restoreTarget.sessionId, birthSessionId: agent.birthSessionId };
}
