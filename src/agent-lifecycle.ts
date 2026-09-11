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
// B2 (restated because this file leans on it constantly): `directory` is
// the resolver's SCOPE, never an agent's identity. `resolveAgent` (imported
// from agent-model.ts) is the only place a `ref` is turned into an agent,
// and its `found-elsewhere` outcome gets its OWN refusal below rather than
// being flattened into `not-found` (BAKR-17 doc's own addition to the
// epic's list) — the resolver went to the trouble of distinguishing the
// two; collapsing them here would throw that away and tell an operator
// their id does not exist when it demonstrably does, just in another
// directory.

import type { ClaimKey } from "./claim-key-resolve";
import { type AgentRecord, type AgentStoreState, checkNameAvailability, resolveAgent, sessionIdToResume, validateNameSyntax } from "./agent-model";

// --- Shared resolution (every verb starts here) ---------------------------

export type ResolutionRefusal =
  | { readonly ok: false; readonly reason: "not-found"; readonly message: string }
  | { readonly ok: false; readonly reason: "found-elsewhere"; readonly message: string; readonly directory: ClaimKey };

export type Resolved = { readonly ok: true; readonly agent: AgentRecord } | ResolutionRefusal;

/**
 * The one entry point every decision function below calls first. B2: an
 * id resolves globally but reports which directory it actually belongs to
 * when that is not `scope`; a name never resolves outside `scope` at all.
 */
export function resolveOrRefuse(state: AgentStoreState, scope: ClaimKey, ref: string): Resolved {
  const outcome = resolveAgent(state, scope, ref);
  if (outcome.outcome === "not-found") {
    const retiredNote = ref.startsWith("@") && state.retiredIds.includes(ref) ? " (this id was deleted — ids are retired on delete and never reused)" : "";
    return { ok: false, reason: "not-found", message: `no agent "${ref}" found in this directory${retiredNote}` };
  }
  if (outcome.outcome === "found-elsewhere") {
    return {
      ok: false,
      reason: "found-elsewhere",
      message: `"${ref}" is an agent id that exists, but in a different directory ("${outcome.directory}") — an id's directory is where it was created, and this is not that directory`,
      directory: outcome.directory,
    };
  }
  return { ok: true, agent: outcome.agent };
}

// --- on: off -> on (B6). Refused while archived — never a silent unarchive. -

export type OnDecision =
  | ResolutionRefusal
  | { readonly ok: false; readonly reason: "archived"; readonly message: string; readonly agent: AgentRecord }
  | { readonly ok: true; readonly kind: "no-change"; readonly agent: AgentRecord }
  | { readonly ok: true; readonly kind: "turn-on"; readonly agent: AgentRecord; readonly priorSessionId: string | undefined };

export function decideOn(state: AgentStoreState, scope: ClaimKey, ref: string): OnDecision {
  const resolved = resolveOrRefuse(state, scope, ref);
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
  if (agent.state === "on") {
    return { ok: true, kind: "no-change", agent };
  }
  // off -> on. `priorSessionId` is resolved through `sessionIdToResume` —
  // the ONE function/call site the ticket's in-place correction requires
  // (2026-09-11: `--resume <durableSessionId>` must not be hard-coded
  // inline, since BAKR-23 may change which id is correct to resume; today
  // it still returns `agent.durableSessionId`). `undefined` covers an agent
  // that has never held a session (e.g. `off` was called before `create`'s
  // own fresh launch ever resolved one), in which case this is a fresh
  // launch rather than a resume. See agent-actions.ts's `on` for the
  // launch-record wedge handling this decision alone does not cover.
  return { ok: true, kind: "turn-on", agent: { ...agent, state: "on" }, priorSessionId: sessionIdToResume(agent) };
}

// --- off: on -> off (B6), and the caller stops `liveSessionId` -------------

export type OffDecision =
  | ResolutionRefusal
  | { readonly ok: false; readonly reason: "archived"; readonly message: string; readonly agent: AgentRecord }
  | { readonly ok: true; readonly kind: "no-change"; readonly agent: AgentRecord }
  | { readonly ok: true; readonly kind: "turn-off"; readonly agent: AgentRecord; readonly liveSessionId: string | undefined };

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
export function decideOff(state: AgentStoreState, scope: ClaimKey, ref: string): OffDecision {
  const resolved = resolveOrRefuse(state, scope, ref);
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
  return { ok: true, kind: "turn-off", agent: { ...agent, state: "off" }, liveSessionId: agent.liveSessionId };
}

// --- archive: {on, off} -> archived, keeping the name (B6) -----------------

export type ArchiveDecision =
  | ResolutionRefusal
  | { readonly ok: true; readonly kind: "no-change"; readonly agent: AgentRecord }
  | { readonly ok: true; readonly kind: "archive"; readonly agent: AgentRecord; readonly liveSessionId: string | undefined };

export function decideArchive(state: AgentStoreState, scope: ClaimKey, ref: string): ArchiveDecision {
  const resolved = resolveOrRefuse(state, scope, ref);
  if (!resolved.ok) return resolved;
  const agent = resolved.agent;

  if (agent.state === "archived") {
    return { ok: true, kind: "no-change", agent };
  }
  // `name` is left untouched (B6: archived agents keep their name, so a
  // later unarchive can never collide).
  return { ok: true, kind: "archive", agent: { ...agent, state: "archived" }, liveSessionId: agent.liveSessionId };
}

// --- unarchive: archived -> off, NEVER on (B6) ------------------------------

export type UnarchiveDecision =
  | ResolutionRefusal
  | { readonly ok: false; readonly reason: "not-archived"; readonly message: string; readonly agent: AgentRecord }
  | { readonly ok: true; readonly agent: AgentRecord };

export function decideUnarchive(state: AgentStoreState, scope: ClaimKey, ref: string): UnarchiveDecision {
  const resolved = resolveOrRefuse(state, scope, ref);
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

// --- rename / name: one function, not two (B4/B5) --------------------------

export type RenameDecision =
  | ResolutionRefusal
  | { readonly ok: false; readonly reason: "empty" | "contains-at" | "reserved"; readonly message: string }
  | { readonly ok: false; readonly reason: "taken"; readonly message: string; readonly heldBy: AgentRecord }
  | { readonly ok: true; readonly kind: "no-change"; readonly agent: AgentRecord }
  | { readonly ok: true; readonly kind: "renamed"; readonly agent: AgentRecord };

/**
 * `name` is this SAME function applied to an agent whose `name` is
 * `undefined` (BAKR-17 doc: "model it as one function, not two") — see the
 * `name` export below, an alias rather than a second implementation.
 * Availability is checked INCLUDING archived holders (B4) via
 * `checkNameAvailability`'s own sweep over every agent in `scope`, and the
 * reserved-word list is re-checked via `validateNameSyntax` exactly as
 * `create` must. Moves nothing (R16): `directory` is never touched here.
 */
export function decideRename(state: AgentStoreState, scope: ClaimKey, ref: string, newName: string): RenameDecision {
  const resolved = resolveOrRefuse(state, scope, ref);
  if (!resolved.ok) return resolved;
  const agent = resolved.agent;

  if (agent.name === newName) {
    return { ok: true, kind: "no-change", agent };
  }
  const syntax = validateNameSyntax(newName);
  if (!syntax.ok) {
    return syntax;
  }
  const availability = checkNameAvailability(state, scope, newName, agent.id);
  if (!availability.ok) {
    return availability;
  }
  return { ok: true, kind: "renamed", agent: { ...agent, name: newName } };
}

/** Alias, not a second implementation — see `decideRename`'s own doc. */
export const decideName = decideRename;

// --- create: name validation only (the mint + launch is agent-actions.ts's job) -

export type CreateNameDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "empty" | "contains-at" | "reserved"; readonly message: string }
  | { readonly ok: false; readonly reason: "taken"; readonly message: string; readonly heldBy: AgentRecord };

/** `name` is optional at create — an unnamed agent is a normal, supported state (every migrated BAKR-16 agent started this way). */
export function decideCreateName(state: AgentStoreState, scope: ClaimKey, name: string | undefined): CreateNameDecision {
  if (name === undefined) {
    return { ok: true };
  }
  const syntax = validateNameSyntax(name);
  if (!syntax.ok) {
    return syntax;
  }
  return checkNameAvailability(state, scope, name);
}

// --- delete: any state -> removed, id retired, name freed (B6) -------------

export type DeleteDecision = ResolutionRefusal | { readonly ok: true; readonly agent: AgentRecord; readonly liveSessionId: string | undefined };

/**
 * No "no-change" diagonal: a second `delete` of the same ref resolves
 * `not-found` on its own (the record is genuinely gone after the first),
 * which is both correct and requires no special-casing here. The actual
 * removal (id retired, record removed from `agents`) is
 * `agent-model.ts`'s `removeAndRetireAgent` — this function only decides
 * THAT the delete is permitted and what session (if any) must be stopped
 * first.
 */
export function decideDelete(state: AgentStoreState, scope: ClaimKey, ref: string): DeleteDecision {
  const resolved = resolveOrRefuse(state, scope, ref);
  if (!resolved.ok) return resolved;
  return { ok: true, agent: resolved.agent, liveSessionId: resolved.agent.liveSessionId };
}

// --- attach target: a query, never an act (R18) ----------------------------

export type AttachDecision =
  | ResolutionRefusal
  | { readonly ok: false; readonly reason: "archived"; readonly message: string; readonly agent: AgentRecord }
  | { readonly ok: false; readonly reason: "off"; readonly message: string; readonly agent: AgentRecord }
  | { readonly ok: false; readonly reason: "not-yet-live"; readonly message: string; readonly agent: AgentRecord }
  | { readonly ok: true; readonly agent: AgentRecord; readonly liveSessionId: string; readonly durableSessionId: string };

/**
 * Resolves an attach target and decides whether it is attachable NOW — it
 * never attaches, opens a terminal, or touches a session itself (R18). An
 * `off` agent is refused with a message saying turning it on is the way,
 * never silently started; `archived` is refused for the same reason
 * on-while-archived is. A THIRD case this file adds, not named explicitly
 * in the epic's list: an `on` agent whose fresh launch has not yet resolved
 * a session at all (`liveSessionId`/`durableSessionId` both still
 * `undefined`) — distinct from both `off` and a genuine live target, so a
 * caller is told to retry shortly rather than being handed a session id
 * that does not exist yet.
 */
export function decideAttachTarget(state: AgentStoreState, scope: ClaimKey, ref: string): AttachDecision {
  const resolved = resolveOrRefuse(state, scope, ref);
  if (!resolved.ok) return resolved;
  const agent = resolved.agent;

  if (agent.state === "archived") {
    return { ok: false, reason: "archived", message: `agent ${agent.id} is archived and cannot be attached to`, agent };
  }
  if (agent.state === "off") {
    return { ok: false, reason: "off", message: `agent ${agent.id} is off — turning it on is the way to attach to it; "attach" never silently starts an agent`, agent };
  }
  if (agent.liveSessionId === undefined || agent.durableSessionId === undefined) {
    return { ok: false, reason: "not-yet-live", message: `agent ${agent.id} is on, but its launch has not resolved a session yet — try again shortly`, agent };
  }
  return { ok: true, agent, liveSessionId: agent.liveSessionId, durableSessionId: agent.durableSessionId };
}
