// The pure agent-record core (BAKR-19, implementing story BAKR-16): the
// single source of truth for lifecycle and membership, subsuming
// session-slots.ts's own onByKey (B1). No filesystem, clock, env, or daemon
// coupling in the logic itself — `now` and any randomness are always
// parameters, mirroring the discipline claim-model.ts and session-slots.ts
// already establish in this tree.
//
// THE SINGLE MOST IMPORTANT INVARIANT (BAKR-16 §1, restated here because
// this file is where it is enforced): an agent is keyed by its own immutable
// id, never by directory and never by name (B2). `directory` and `name` are
// both attributes that SCOPE a question; neither may ANSWER one. Every
// function in this file that accepts a `directory` uses it to narrow a
// search space, never to identify a single agent.
//
// What this file deliberately does NOT ship (BAKR-16 §3): no create / on /
// off / rename / archive / unarchive / delete / adopt verb. Those are a
// sibling story. What IS shipped: the record shape, id minting, name syntax
// and availability rules (the pure, typed refusals those future verbs will
// consult — B11), the resolver (B4/R-E), the membership query (B9/R-D), and
// the launch-bookkeeping this store subsumes from session-slots.ts (B1) —
// rekeyed to the agent id throughout (B2, R-C). `putAgent` below is a raw,
// unvalidated insert — the primitive a migration or a future verb's own
// validated wrapper builds on, not itself a "create" verb (it performs no
// name-availability or reserved-word check; that is the future verb's job,
// using `validateNameSyntax`/`checkNameAvailability` below).

import type { ClaimKey } from "./claim-key-resolve";
import type { McpServerDeclaration } from "./launch-config";
import { stripAnsi } from "./spawn/parse";
import { computeAgentNames } from "./agent-name";

export type AgentLifecycleState = "on" | "off" | "archived";

/**
 * `directory` and `name` are both attributes (B2/B4) — never the key. `id`
 * is the only field this store ever looks an agent up by internally;
 * `resolveAgent` below is the one function that accepts a directory-scoped
 * or global reference from a caller and translates it to one of these.
 */
/**
 * BAKR-22: the one field bakr actually restores from, and (per that
 * ticket's own measurement) the one field it also checks liveness against
 * — a single pair rather than the old two-field split, because the
 * rationale for two fields no longer holds. Under `claude --bg --resume`
 * the session id ROTATED on every restore, so "the id to check liveness
 * for" and "the durable identity" had to be kept apart (conflating them is
 * exactly what caused the original restore-spawn loop — see
 * `session-slots.ts`'s own incident comment). Under `claude respawn`, the
 * id no longer rotates on an ordinary restore at all — the only thing that
 * ever changes this field is a successful `forkFrom` (the moved-directory
 * escape), a rare, explicit, single event, not routine rotation. The one
 * place `sessionId` and `shortId` could diverge — mid-`forkFrom`, between
 * minting the new session and the store write landing — is closed by B12:
 * this field is only ever read and written inside the same lock hold as
 * the decision that produced it.
 */
export interface RestoreTarget {
  readonly sessionId: string;
  readonly shortId: string;
}

export interface AgentRecord {
  readonly id: string;
  readonly name: string | undefined;
  readonly directory: ClaimKey;
  readonly state: AgentLifecycleState;
  readonly createdAt: number;
  /**
   * BAKR-22: pure birth provenance. Set once, at this agent's first-ever
   * launch, from the session id that launch resolved to — and NEVER
   * written again after that. No restore decision anywhere in this tree
   * reads this field; it exists only so a human (or a future incident
   * report) can answer "what session was this agent born from". Renamed
   * from `durableSessionId`, which BAKR-22 measured to be a lie in
   * practice: `claude --bg --resume` forks on every restore on at least
   * one still-supported claude build (2.1.251), so a field claiming to be
   * the thing bakr restores from, while never changing, was asserting a
   * story the substrate did not honor. This field makes no restore claim
   * at all — see `restoreTarget` for the field that does.
   */
  readonly birthSessionId: string | undefined;
  /** See `RestoreTarget`'s own doc. `undefined` only before this agent's first launch has resolved a session at all. */
  readonly restoreTarget: RestoreTarget | undefined;
  /**
   * The MCP servers this agent may use, and which it must hear notifications
   * from — bakr's own declaration, rendered per vendor by drovr at every start
   * (launch-config.ts). Absent means the default — every server the
   * directory's `.mcp.json` configures, each subscribed to — which is not the
   * same as an empty declaration: `[]` is an agent that uses no MCP at all.
   */
  readonly mcp?: readonly McpServerDeclaration[];
}

/**
 * One launch attempt this daemon (or the provisional harness) is responsible
 * for, tracked from BEFORE `launch()` is even called through to resolution —
 * ported wholesale from session-slots.ts's own `LaunchRecord` (same three
 * states, same "persist before launch()" discipline), with ONE change:
 * `agentId` is now the field a resolution is matched on (B8's fix for
 * defect 1 — "attaches a fresh launch's session by directory"). `key`
 * remains, as an ATTRIBUTE naming which directory to launch into (AC9's own
 * sweep item), never again what a resolution is keyed by.
 */
/**
 * BAKR-22: the identity actually attempted, tagged by which mechanism
 * produced the attempt — never a "durable" id, never implicitly one id
 * space. `respawn`'s target is a SHORT id (`claude respawn` rejects a full
 * session uuid outright — measured); `forkFrom`'s target is the FULL
 * session id being forked FROM (never the new id a successful fork would
 * produce — see `planRestore`'s own doc for why forking from anything
 * other than the agent's current `restoreTarget` would reintroduce this
 * ticket's own rewind bug, gated on "moved twice" instead of "restored
 * twice"). `undefined` means a fresh launch (no prior session at all).
 *
 * THE KEYING RULE THAT MAKES B13 WORK WITH NO FORK-SPECIFIC BRANCH:
 * a launch record keys on the exact identity value that was actually
 * attempted, not on what it might resolve to. Neither a `respawn` target
 * (a short id) nor a `forkFrom` source (a pre-fork session id) ever
 * changes on FAILURE — only a successful resolution changes either. So a
 * run of failures against the same key accumulates against the same key
 * every time, and `hasLaunchRecordFor`'s existing "a matching record with
 * `error` set blocks forever" mechanism needs no special case for either
 * kind: a give-up on a `respawn` target stays a give-up on that exact
 * short id; a give-up on a `forkFrom` source stays a give-up on that exact
 * session id. It stops matching only once a *different* attempt is made
 * against a *different* key, which only happens after an actual
 * successful resolution.
 */
export type AttemptKey = { readonly kind: "respawn"; readonly shortId: string } | { readonly kind: "forkFrom"; readonly sessionId: string };

function attemptKeyEquals(a: AttemptKey | undefined, b: AttemptKey | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.kind !== b.kind) return false;
  return a.kind === "respawn" ? a.shortId === (b as { shortId: string }).shortId : a.sessionId === (b as { sessionId: string }).sessionId;
}

export interface LaunchRecord {
  readonly attemptId: string;
  readonly agentId: string;
  readonly key: ClaimKey;
  /** See `AttemptKey`'s own doc. `undefined` for a fresh launch (no prior session at all). */
  readonly attemptKey: AttemptKey | undefined;
  readonly attemptedAt: number;
  readonly launchShortId: string | undefined;
  readonly error: string | undefined;
}

/**
 * R-C.3's third migration case: a v1 launch record whose `launchShortId` was
 * already set (so `launch()` genuinely succeeded) but which has no
 * `priorSessionId` — a FRESH registration in flight when the old binary
 * stopped, with no agent yet to attach to under the old model (no `onByKey`
 * slot exists for something that was still resolving). Marking it
 * unresolved at migration would orphan a live session the operator
 * deliberately started; matching it to an existing agent would be
 * fabricating a link this product forbids. Kept separate from `launches`
 * so the type of an ordinary `LaunchRecord.agentId` can stay a real,
 * always-existing agent id everywhere else — this is the one shape in the
 * whole store that resolves into a BRAND NEW agent rather than updating one
 * that already exists. See `resolvePendingCreation` and
 * agent-store-migrate.ts's own module comment for the exact rule.
 */
export interface PendingCreationRecord {
  readonly attemptId: string;
  /** The directory this record's own OLD `LaunchRecord.key` named as its launch target — NEVER a listing entry's `cwd` (B2). */
  readonly key: ClaimKey;
  readonly launchShortId: string;
  readonly attemptedAt: number;
}

/** R-A: one file, one atomic write, so a create and its launch record can never land in different files with a crash between them (B12). */
export interface AgentStoreState {
  readonly agents: { readonly [agentId: string]: AgentRecord };
  /** B6: delete means "not in the set", with the id explicitly retired so a re-mint can never collide. Nothing in this story's own scope populates this — the delete verb ships in the sibling story — but the field ships now so that store is forward-compatible. */
  readonly retiredIds: readonly string[];
  readonly launches: readonly LaunchRecord[];
  /** R-C: rekeyed to the agent id (was the durable session id in session-slots.ts) — works before an agent has any durable session id at all, which a freshly created agent does not. */
  readonly restoreAttemptCounts: { readonly [agentId: string]: number };
  /** R-C.3 case 3 — see `PendingCreationRecord`. Empty outside of migration's own output; nothing in ordinary daemon operation ever adds to this list (every ordinary fresh launch already has a real, pre-existing agent to attach to — see daemon.ts's `decideAndBeginForAgent`). */
  readonly pendingCreations: readonly PendingCreationRecord[];
}

export function emptyAgentStore(): AgentStoreState {
  return { agents: {}, retiredIds: [], launches: [], restoreAttemptCounts: {}, pendingCreations: [] };
}

// --- Id minting (B3) ---------------------------------------------------

/** Lowercase Crockford base32 — excludes i, l, o, u to avoid visual confusion with 1/1/0/v. */
const CROCKFORD_BASE32 = "0123456789abcdefghjkmnpqrstvwxyz";
export const AGENT_ID_BODY_LENGTH = 18;

/**
 * `@` + 18 lowercase Crockford base32 characters (B3). Takes a random-bytes
 * source as its ONLY input — deliberately NOT a clock — because an id must
 * stay unique across many mintings within the same millisecond (AC5), and
 * the way to guarantee that is to never let time influence the id's bytes
 * in the first place. A defect where injected randomness collapsed every
 * same-millisecond id to identical bytes has been caught before in this
 * estate (ticket AC5); this function's signature makes that class of bug
 * impossible to reintroduce by construction — there is no `now` parameter
 * to accidentally seed anything from.
 *
 * 18 base32 characters need 90 bits; `randomBytes` is asked for the 12
 * bytes (96 bits) that comfortably cover that, and any surplus bits are
 * simply not consumed.
 */
export function mintAgentId(randomBytes: (byteLength: number) => Uint8Array): string {
  const bytes = randomBytes(Math.ceil((AGENT_ID_BODY_LENGTH * 5) / 8));
  let bitBuffer = 0;
  let bitCount = 0;
  let body = "";
  for (const byte of bytes) {
    bitBuffer = (bitBuffer << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5 && body.length < AGENT_ID_BODY_LENGTH) {
      bitCount -= 5;
      body += CROCKFORD_BASE32[(bitBuffer >> bitCount) & 0x1f];
    }
  }
  // Only reachable if `randomBytes` returns fewer bytes than asked for.
  while (body.length < AGENT_ID_BODY_LENGTH) {
    body += CROCKFORD_BASE32[0];
  }
  return `@${body}`;
}

/** True when `id` is already in use by a live record, or has been explicitly retired (B6) — either way, a re-mint must not collide with it. */
export function isIdTakenOrRetired(state: AgentStoreState, id: string): boolean {
  return id in state.agents || state.retiredIds.includes(id);
}

/** Mints an id and re-rolls on the (astronomically unlikely, at 90 bits of entropy) chance of a collision against this store's own known/retired ids. */
export function mintUniqueAgentId(state: AgentStoreState, randomBytes: (byteLength: number) => Uint8Array): string {
  let id = mintAgentId(randomBytes);
  while (isIdTakenOrRetired(state, id)) {
    id = mintAgentId(randomBytes);
  }
  return id;
}

// --- Name rules (BAKR-34/BAKR-42 R9): custom names, `name`/`rename`, and
// their reserved-word/availability checks are RETIRED — an agent's name is
// now always derived from its directory (R1/R3, agent-name.ts). What
// remains of `AgentRecord.name` is legacy-only, read solely by the R8 rename
// hint below.

// --- Membership (B9, R-D) ------------------------------------------------

/**
 * Membership is a DERIVED query, never a stored second copy (R-D — this is
 * what retires `Claim.agentIds` from the in-memory model; see
 * claim-model.ts for the wire-compat half of that ruling). `directory`
 * SCOPES this query; it is never how a single agent is identified.
 */
export function agentsInDirectory(state: AgentStoreState, directory: ClaimKey): readonly AgentRecord[] {
  return Object.values(state.agents).filter((a) => a.directory === directory);
}

export function listAgents(state: AgentStoreState): readonly AgentRecord[] {
  return Object.values(state.agents);
}

export function lookupAgentById(state: AgentStoreState, id: string): AgentRecord | undefined {
  return state.agents[id];
}

/** Raw, unvalidated insert/replace — the primitive a migration or a future validated verb builds on. Performs no name/reserved-word/availability check of its own; see the module comment. */
export function putAgent(state: AgentStoreState, agent: AgentRecord): AgentStoreState {
  return { ...state, agents: { ...state.agents, [agent.id]: agent } };
}

/** Replaces an agent's MCP declaration; `undefined` returns it to the default (every server its `.mcp.json` configures). A no-op when `agentId` names no agent. */
export function setAgentMcp(state: AgentStoreState, agentId: string, mcp: readonly McpServerDeclaration[] | undefined): AgentStoreState {
  const agent = state.agents[agentId];
  if (agent === undefined) return state;
  const { mcp: _previous, ...rest } = agent;
  return putAgent(state, mcp === undefined ? rest : { ...rest, mcp });
}

/**
 * BAKR-21: `delete`'s primitive — removes the record from `agents` and adds
 * its id to `retiredIds` (B6: "deleted means removed, with the id retired
 * and the name freed") — this is `retiredIds`'s first writer, as this
 * file's own module comment already said it would be. A no-op, like every
 * other mutator here, if `agentId` is not currently present — total, never
 * throws.
 */
export function removeAndRetireAgent(state: AgentStoreState, agentId: string): AgentStoreState {
  if (!(agentId in state.agents)) return state;
  const agents = { ...state.agents };
  delete agents[agentId];
  return { ...state, agents, retiredIds: [...state.retiredIds, agentId] };
}

/**
 * Raw, unvalidated rewrite of one agent's `directory` — the primitive
 * adopt.ts's validated wrapper builds on (this file ships no "adopt" verb
 * of its own, per the module comment above). Performs no name-collision,
 * source-membership, or claim check; the caller is responsible for every
 * refusal in B11's typed set before calling this. A no-op (same object
 * returned) when `agentId` names no agent, mirroring every other total
 * mutator in this file.
 */
export function setAgentDirectory(state: AgentStoreState, agentId: string, directory: ClaimKey): AgentStoreState {
  const agent = state.agents[agentId];
  if (agent === undefined || agent.directory === directory) return state;
  return { ...state, agents: { ...state.agents, [agentId]: { ...agent, directory } } };
}

// --- The resolver (BAKR-34/BAKR-42 R2/R4/R8) -------------------------------

/**
 * R2's lexical classification, already turned into data: an `id` or `name`
 * ref carries the raw string; a `directory` ref carries the ClaimKey the
 * caller already resolved from a real-path ref (symlink-aware resolution is
 * impure — `agent-model.ts` never touches the filesystem, so that step is
 * always the caller's job; see `src/cli/ref.ts`). This is what makes
 * "@" / real-path / name mutually exclusive by construction rather than by
 * convention: a caller cannot even construct a `RefClassification` without
 * having already made that lexical call.
 */
export type RefClassification =
  | { readonly kind: "id"; readonly ref: string }
  | { readonly kind: "directory"; readonly directory: ClaimKey }
  | { readonly kind: "name"; readonly ref: string };

export type ResolveOutcome =
  | { readonly outcome: "found"; readonly agent: AgentRecord }
  | { readonly outcome: "not-found" }
  /** R6: a legacy store already violating "one non-archived agent per directory" must still load — this is the read-time consequence, never a load-time crash. `agents` names every non-archived agent sharing the directory a `name`/`directory` ref resolved to. */
  | { readonly outcome: "ambiguous"; readonly agents: readonly AgentRecord[] }
  /** R8: `ref` is not an id, not a real path, and not any agent's current derived name — but it does equal some non-archived agent's legacy stored `name`. `derivedName` is that agent's current name, when it has one (its own directory might itself be ambiguous, in which case there is no single name to suggest and a caller should point at `@id` instead). */
  | { readonly outcome: "renamed"; readonly agent: AgentRecord; readonly derivedName: string | undefined };

/**
 * R4: resolution is global — an id resolves from any directory, and a name
 * is resolved against the CURRENT derived-name set (agent-name.ts),
 * likewise independent of any caller cwd. `directory` (a real-path ref,
 * already resolved by the caller) matches by exact equality against
 * non-archived agents only, the same rule `computeAgentNames` applies (R3:
 * archived agents are @id-only) — this is also what makes R6's
 * one-per-directory enforcement and its `ambiguous` escape hatch apply
 * uniformly whether an agent was reached by name or by real path.
 */
export function resolveAgent(state: AgentStoreState, classification: RefClassification): ResolveOutcome {
  if (classification.kind === "id") {
    const agent = state.agents[classification.ref];
    return agent === undefined ? { outcome: "not-found" } : { outcome: "found", agent };
  }

  if (classification.kind === "directory") {
    const matches = Object.values(state.agents).filter((a) => a.directory === classification.directory && a.state !== "archived");
    if (matches.length === 0) return { outcome: "not-found" };
    if (matches.length === 1) return { outcome: "found", agent: matches[0]! };
    return { outcome: "ambiguous", agents: matches };
  }

  const names = computeAgentNames(Object.values(state.agents));
  for (const [directory, name] of names.directoryToName) {
    if (name !== classification.ref) continue;
    const ids = names.agentIdsByDirectory.get(directory) ?? [];
    if (ids.length === 1) return { outcome: "found", agent: state.agents[ids[0]!]! };
    if (ids.length > 1) return { outcome: "ambiguous", agents: ids.map((id) => state.agents[id]!) };
  }

  // R8: the one-release rename hint. Restricted to a non-archived legacy
  // holder — an archived agent has no derived name at all (R3), so there is
  // nothing this hint could point at for one.
  const legacyHolder = Object.values(state.agents).find((a) => a.state !== "archived" && a.name === classification.ref);
  if (legacyHolder !== undefined) {
    return { outcome: "renamed", agent: legacyHolder, derivedName: names.nameByAgentId.get(legacyHolder.id) };
  }

  return { outcome: "not-found" };
}

// --- Which session to resume (BAKR-22: respawn, with a fork-only escape) --

/**
 * THE SINGLE FUNCTION every restore/adopt caller must go through to answer
 * "what do I do to restore this agent?" — never read `agent.restoreTarget`
 * or `agent.birthSessionId` inline at a call site. Call sites: `decideOn`
 * (the `on` verb) and `daemon.ts`'s reconcile restore.
 *
 * BAKR-22 measured (raw results on the ticket) that `claude --bg --resume`
 * forks on at least one still-supported build (2.1.251) even under bakr's
 * own exact invocation shape, while `claude respawn <shortId>` does not
 * fork on any build measured (2.1.251, 2.1.268, and across a build change)
 * — same session id every time, full content retention, no model-turn
 * cost on a cleanly-completed prior turn. So the ordinary path is
 * `respawn`, keyed on the short id `respawn` requires (it rejects a full
 * session uuid outright — measured). This function NEVER returns a
 * `forkFrom` plan itself — `forkFrom` is reached only reactively, by the
 * caller, after `respawn` has returned the one recognised stale-cwd
 * refusal (see `RESPAWN_STALE_CWD_MARKER` in spawn/respawn.ts) — never
 * chosen up front, and never from any other non-zero result (an
 * unrecognised failure must refuse loudly, never fall through to a fork:
 * forking when the failure meant something else would abandon a live
 * conversation and mint a new one).
 */
export type RestorePlan = { readonly kind: "fresh" } | { readonly kind: "respawn"; readonly shortId: string };

export function planRestore(agent: AgentRecord): RestorePlan {
  if (agent.restoreTarget === undefined) {
    return { kind: "fresh" };
  }
  return { kind: "respawn", shortId: agent.restoreTarget.shortId };
}

// --- Restore-attempt bookkeeping (R-C: rekeyed to agent id) ---------------

export function restoreAttemptCount(state: AgentStoreState, agentId: string): number {
  return state.restoreAttemptCounts[agentId] ?? 0;
}

export function recordRestoreAttempt(state: AgentStoreState, agentId: string): AgentStoreState {
  return {
    ...state,
    restoreAttemptCounts: { ...state.restoreAttemptCounts, [agentId]: restoreAttemptCount(state, agentId) + 1 },
  };
}

/** A no-op (not merely harmless, structurally absent from the object) when there is nothing to reset — mirrors session-slots.ts's own `resetRestoreAttempts` exactly, rekeyed. */
export function resetRestoreAttempts(state: AgentStoreState, agentId: string): AgentStoreState {
  if (!(agentId in state.restoreAttemptCounts)) return state;
  const restoreAttemptCounts = { ...state.restoreAttemptCounts };
  delete restoreAttemptCounts[agentId];
  return { ...state, restoreAttemptCounts };
}

// --- Launch bookkeeping (ported from session-slots.ts, rekeyed to agentId) -

export function pendingLaunches(state: AgentStoreState): readonly LaunchRecord[] {
  return state.launches.filter((l) => l.error === undefined);
}

export function unresolvedLaunches(state: AgentStoreState): readonly LaunchRecord[] {
  return state.launches.filter((l) => l.error !== undefined);
}

/**
 * B13a (BAKR-26/BAKR-27): "a recognised stale-cwd refusal is not an
 * unresolved launch." claude refused `respawn` before starting anything, so
 * once the escape it triggers (`forkFrom`, or a `fresh` launch on positive
 * no-transcript evidence — see daemon.ts's `dispatchRespawnForDaemon` and
 * agent-actions.ts's `forkFromCurrentTarget`, both of which key that escape
 * as `attemptKey: {kind: "forkFrom", sessionId}` regardless of which of the
 * two it actually ran) has RESOLVED into a real session, nothing was ever
 * left orphaned by the refusal — it is not a genuinely unresolved launch to
 * report every cycle, only a one-time event the daemon already logs loudly
 * at the point of refusal.
 *
 * DETECTED BY INFERENCE, NOT A STORED FLAG — deliberately, so this needs no
 * new write, no wire-format migration, and treats a record THIS build just
 * created identically to one a PRE-B13a build already wrote to disk (AC6):
 * `resolveLaunch` moves an agent's `restoreTarget` ONLY on a successful
 * `fresh`/`forkFrom` resolution (never on a bare `respawn`, and never on any
 * failure — see that function's own doc). So a `respawn`-keyed FAILED
 * record whose own error is the recognised stale-cwd shape, but whose
 * owning agent's CURRENT `restoreTarget.shortId` no longer equals the
 * shortId that failed, is proof — from data the store already holds, with
 * nothing new written to produce it — that some LATER launch for this exact
 * agent resolved successfully after this respawn was refused. That is
 * exactly B13a's "the escape succeeded" case.
 *
 * Takes the stale-cwd recognizer as a parameter rather than importing one:
 * this file stays free of any dependency on the spawn substrate (its own
 * module doc: "no filesystem, clock, env, or daemon coupling"), even though
 * `isRecognizedStaleCwdRefusal` (spawn/respawn.ts) is itself a pure
 * string-matching function — the caller (daemon.ts) already has it.
 *
 * NEVER used to CLEAR anything — B13 still holds absolutely ("only an
 * explicit operator action may clear a failed or given-up launch record;
 * the reconcile loop never does"). This function only tells a REPORTING
 * call site whether a record is worth surfacing again; the record itself
 * stays in the store, untouched, forever, exactly as every other
 * unresolved-but-never-retried record does.
 */
export function isSupersededStaleCwdRespawnFailure(state: AgentStoreState, record: LaunchRecord, isRecognizedStaleCwdRefusal: (errorText: string) => boolean): boolean {
  if (record.error === undefined) return false;
  if (record.attemptKey === undefined || record.attemptKey.kind !== "respawn") return false;
  if (!isRecognizedStaleCwdRefusal(record.error)) return false;
  const agent = state.agents[record.agentId];
  if (agent?.restoreTarget === undefined) return false;
  return agent.restoreTarget.shortId !== record.attemptKey.shortId;
}

/** See session-slots.ts's own doc for why this must be called unconditionally on every load — identical reasoning, ported. */
export function promoteUnresolvableLaunches(state: AgentStoreState, reason: string, attemptedAtOrBefore: number = Number.POSITIVE_INFINITY): AgentStoreState {
  let next = state;
  for (const record of state.launches) {
    if (record.launchShortId === undefined && record.error === undefined && record.attemptedAt <= attemptedAtOrBefore) {
      next = markLaunchFailed(next, record.attemptId, reason);
    }
  }
  return next;
}

/**
 * True when a launch attempt for exactly this `(agentId, attemptKey)` pair
 * already exists. Keyed by AGENT id now, not by directory — this is what
 * makes two agents launched fresh into the SAME directory in the SAME
 * cycle independent of one another (AC4): each has its own agent id, so
 * each gets its own guard entry, regardless of arrival order. `attemptKey`
 * is compared as a whole tagged value (see `AttemptKey`'s own doc for why
 * this is what makes B13 work unmodified for both `respawn` and
 * `forkFrom`).
 */
export function hasLaunchRecordFor(state: AgentStoreState, agentId: string, attemptKey: AttemptKey | undefined): boolean {
  return state.launches.some((l) => l.agentId === agentId && attemptKeyEquals(l.attemptKey, attemptKey));
}

/**
 * BAKR-21: the operator-driven recovery for the launch-record wedge
 * confirmed on this ticket (BAKR-17 comment, 2026-09-11) — `promoteUnresolvableLaunches`
 * marks a crashed-mid-launch record FAILED (`error` set), but `resolveLaunch`
 * only ever removes a record whose `error` is still `undefined`, and
 * `hasLaunchRecordFor` does not look at `error` at all. So a failed record
 * for `(agentId, attemptKey)` is otherwise PERMANENT: it blocks
 * `decideAndBeginForAgent` on both the fresh-launch and the restore arm,
 * forever, with no code path that ever removes it.
 *
 * This function is that removal — but it removes ONLY a record whose
 * `error` is already set (i.e. one `promoteUnresolvableLaunches` or a
 * direct `markLaunchFailed` has already given up on). It is a no-op against
 * a genuinely in-flight record (`error === undefined`, whether or not
 * `launchShortId` is set yet) — clearing THAT would risk a duplicate launch
 * racing a resolution that is still coming, which is exactly the hazard
 * `hasLaunchRecordFor`'s guard exists to prevent (AC4).
 *
 * MUST be called only from an explicit, operator-initiated verb
 * (`agent-actions.ts`'s `on`) — never from `daemon.ts` or anything reachable
 * from its reconcile loop. B7 stays intact: "never retried automatically"
 * was written for an unattended loop; an operator who calls `on` again
 * after a launch demonstrably failed is not that.
 */
export function clearFailedLaunchRecord(state: AgentStoreState, agentId: string, attemptKey: AttemptKey | undefined): AgentStoreState {
  const record = state.launches.find((l) => l.agentId === agentId && attemptKeyEquals(l.attemptKey, attemptKey) && l.error !== undefined);
  if (record === undefined) return state;
  return { ...state, launches: state.launches.filter((l) => l.attemptId !== record.attemptId) };
}

/**
 * BAKR-27 AC4: `on`'s wedge-clear (see `clearFailedLaunchRecord`, right
 * above) only ever computes ONE attemptKey — `respawn(shortId)` or
 * `undefined` (fresh) — from `planRestore(agent)`, because a `forkFrom`
 * escape's OWN failure (its `launch()` call itself failing, not the
 * respawn it was escaping) is recorded under a DIFFERENT key entirely:
 * `forkFrom(sessionId)`, keyed on the pre-escape session it was trying to
 * fork FROM (see `dispatchRespawnForDaemon`/`forkFromCurrentTarget`'s own
 * `beginLaunch` call). `planRestore` never returns a `forkFrom` plan — it
 * only ever answers "respawn this shortId" or "launch fresh" — so no
 * attemptKey `on` computes can ever equal a stranded `forkFrom` record's
 * key, and `clearFailedLaunchRecord` alone can never reach it. That
 * record then sits unresolved and reported forever, with no verb able to
 * clear it — the exact shape BAKR-26 suspected and this ticket's own AC4
 * asks to be enumerated and fixed.
 *
 * This is that fix's primitive: removes every FAILED `forkFrom`-keyed
 * record whose `sessionId` matches the agent's CURRENT
 * `restoreTarget.sessionId` — the one a retried escape would target again,
 * so leaving an old failed attempt at that same key around serves no
 * purpose but noise (a fresh retry begins its OWN new attemptId regardless
 * of whether an old one is cleared here; nothing depends on this beyond
 * reporting). Every failed record at that key is removed, not just one —
 * repeated failed retries before this fix shipped could have left more
 * than one. A no-op (same object, empty list) when `sessionId` is
 * `undefined` (a never-restored agent has no target to match against) or
 * nothing matches. MUST be called only from an explicit operator verb
 * (`on`) — never from `daemon.ts` — for the identical B13 reason
 * `clearFailedLaunchRecord` already carries.
 */
export function clearFailedForkFromRecordsForCurrentTarget(state: AgentStoreState, agentId: string, sessionId: string | undefined): { readonly state: AgentStoreState; readonly clearedAttemptIds: readonly string[] } {
  if (sessionId === undefined) return { state, clearedAttemptIds: [] };
  const matches = state.launches.filter((l) => l.agentId === agentId && l.error !== undefined && l.attemptKey?.kind === "forkFrom" && l.attemptKey.sessionId === sessionId);
  if (matches.length === 0) return { state, clearedAttemptIds: [] };
  const clearedAttemptIds = matches.map((m) => m.attemptId);
  const ids = new Set(clearedAttemptIds);
  return { state: { ...state, launches: state.launches.filter((l) => !ids.has(l.attemptId)) }, clearedAttemptIds };
}

export function beginLaunch(state: AgentStoreState, agentId: string, key: ClaimKey, attemptKey: AttemptKey | undefined, attemptId: string, now: number): AgentStoreState {
  const record: LaunchRecord = { attemptId, agentId, key, attemptKey, attemptedAt: now, launchShortId: undefined, error: undefined };
  return { ...state, launches: [...state.launches, record] };
}

function updateLaunch(state: AgentStoreState, attemptId: string, update: (record: LaunchRecord) => LaunchRecord): AgentStoreState {
  const index = state.launches.findIndex((l) => l.attemptId === attemptId);
  if (index === -1) return state;
  const launches = [...state.launches];
  launches[index] = update(launches[index] as LaunchRecord);
  return { ...state, launches };
}

export function markLaunchStarted(state: AgentStoreState, attemptId: string, launchShortId: string): AgentStoreState {
  return updateLaunch(state, attemptId, (record) => ({ ...record, launchShortId }));
}

export function markLaunchFailed(state: AgentStoreState, attemptId: string, error: string): AgentStoreState {
  return updateLaunch(state, attemptId, (record) => ({ ...record, error }));
}

/**
 * Removes EVERY launch record (pending or already-errored/given-up) belonging
 * to any of `agentIds` — the primitive adopt.ts's validated wrapper uses to
 * implement the Q5 decision (BAKR-24): adoption discards ALL of the adopted
 * agents' launch records, not only the ones the move itself would explain,
 * because the only available signal for "this record's cause no longer
 * applies" (its error string) has already been measured to misattribute its
 * own cause (a missing-cwd launch failure reads as a `systemd-run` problem).
 * An explicit operator act (adopt) is treated as a deliberate reset of any
 * prior give-up, consistent with — not a hole in — BAKR-8 Constraint 2's
 * "never retried automatically" (the daemon never calls this on its own).
 * A no-op (same object) when none of `agentIds` has any launch record.
 */
export function discardLaunchRecordsForAgents(state: AgentStoreState, agentIds: readonly string[]): AgentStoreState {
  const ids = new Set(agentIds);
  const launches = state.launches.filter((l) => !ids.has(l.agentId));
  if (launches.length === state.launches.length) return state;
  return { ...state, launches };
}

/**
 * A later listing found `launchShortId` with session id `resolvedSessionId`
 * — finalizes the matching pending record, attaching the outcome to the
 * AGENT that requested it (`record.agentId`), never to a directory-keyed
 * list (the fix for defect 1 in BAKR-16 §4). Removes the launch record
 * either way. Applies to `fresh` and `forkFrom` launches ONLY — a
 * `respawn` attempt never needs this (its result is synchronous and its
 * identity never changes; see `resolveRespawnAttempt`).
 *
 * - Fresh launch (`attemptKey === undefined`): sets the agent's
 *   `birthSessionId`/`restoreTarget` to `resolvedSessionId`/`launchShortId`,
 *   but only if the agent does not already have a birth session id —
 *   idempotent against a duplicate resolution, and never overwrites an
 *   existing session the way BAKR-13's own regression forbids.
 * - `forkFrom` (attemptKey.kind === "forkFrom"): updates ONLY
 *   `restoreTarget`, and only when the attempt's own pre-fork session id
 *   still matches the agent's CURRENT `restoreTarget.sessionId` —
 *   `birthSessionId` itself is NEVER touched here. Matching against
 *   `restoreTarget` rather than `birthSessionId` is BAKR-22's own
 *   correction: forking from anything other than the agent's current
 *   target would discard whatever happened since the last fork,
 *   reintroducing this ticket's own rewind bug gated on "moved twice"
 *   instead of "restored twice".
 * - If the agent named by `record.agentId` no longer exists (defensive —
 *   should not happen while no delete verb ships), the launch record is
 *   still removed rather than left to wedge future cycles, but no agent is
 *   fabricated.
 *
 * A no-op if no pending record matches `launchShortId` — total, like every
 * other mutator in this file.
 */
export function resolveLaunch(state: AgentStoreState, launchShortId: string, resolvedSessionId: string): AgentStoreState {
  const record = state.launches.find((l) => l.launchShortId === launchShortId && l.error === undefined);
  if (record === undefined) return state;

  const launches = state.launches.filter((l) => l.attemptId !== record.attemptId);
  const agent = state.agents[record.agentId];
  if (agent === undefined) {
    return { ...state, launches };
  }

  let nextAgent: AgentRecord = agent;
  if (record.attemptKey !== undefined && record.attemptKey.kind === "forkFrom") {
    if (agent.restoreTarget?.sessionId === record.attemptKey.sessionId) {
      nextAgent = { ...agent, restoreTarget: { sessionId: resolvedSessionId, shortId: launchShortId } };
    }
  } else if (record.attemptKey === undefined && agent.birthSessionId === undefined) {
    nextAgent = { ...agent, birthSessionId: resolvedSessionId, restoreTarget: { sessionId: resolvedSessionId, shortId: launchShortId } };
  }

  return { ...state, agents: { ...state.agents, [agent.id]: nextAgent }, launches };
}

/**
 * `claude respawn <shortId>` resolves SYNCHRONOUSLY — no later listing is
 * needed to learn a session id, because `respawn` never changes it (BAKR-22
 * measurement). This is the `respawn`-kind counterpart to `resolveLaunch`:
 * on success, the pending record is simply removed (the agent's
 * `restoreTarget` needs no update — it was already correct, and BAKR-22
 * measured that `respawn` does not rotate it). Total, like every other
 * mutator here: a no-op if no pending record matches.
 */
export function resolveRespawnAttempt(state: AgentStoreState, attemptId: string, newShortId?: string): AgentStoreState {
  const record = state.launches.find((l) => l.attemptId === attemptId && l.error === undefined);
  if (record === undefined) return state;
  const launches = state.launches.filter((l) => l.attemptId !== record.attemptId);
  const agent = state.agents[record.agentId];
  // Under herdr a restore resumes the SAME session in a NEW pane: the session id stays, the handle moves.
  if (newShortId === undefined || agent?.restoreTarget === undefined) return { ...state, launches };
  return { ...state, launches, agents: { ...state.agents, [agent.id]: { ...agent, restoreTarget: { ...agent.restoreTarget, shortId: newShortId } } } };
}

/**
 * R-C.3 case 3: resolves a migration-recovered `PendingCreationRecord` by
 * MINTING a brand-new, unnamed `on` agent — the one place in this store
 * that creates an agent as a side effect of a resolution rather than
 * updating one that already exists. `mintId` is called only when a match is
 * found (never speculatively), and `record.key` — the directory the OLD
 * `LaunchRecord` itself named as its launch target — is what the new
 * agent's `directory` is set to, NEVER a listing entry's own `cwd` (B2: the
 * directory scopes, it does not identify — and a listing's `cwd` is
 * exactly the kind of directory-derived signal this product forbids
 * resolving an agent from).
 *
 * A no-op if no pending creation matches `launchShortId` — total, like
 * every other mutator in this file.
 */
export function resolvePendingCreation(state: AgentStoreState, launchShortId: string, resolvedSessionId: string, mintId: () => string, now: number): AgentStoreState {
  const record = state.pendingCreations.find((p) => p.launchShortId === launchShortId);
  if (record === undefined) return state;

  const pendingCreations = state.pendingCreations.filter((p) => p.attemptId !== record.attemptId);
  const id = mintId();
  const agent: AgentRecord = {
    id,
    name: undefined,
    directory: record.key,
    state: "on",
    createdAt: now,
    birthSessionId: resolvedSessionId,
    restoreTarget: { sessionId: resolvedSessionId, shortId: launchShortId },
  };
  return { ...state, agents: { ...state.agents, [id]: agent }, pendingCreations };
}

// --- Wire format -----------------------------------------------------

export const AGENT_STORE_VERSION = 2;

interface PersistedRestoreTarget {
  readonly sessionId: string;
  readonly shortId: string;
}

interface PersistedAttemptKey {
  readonly kind: "respawn" | "forkFrom";
  readonly shortId: string | null;
  readonly sessionId: string | null;
}

interface PersistedAgentRecord {
  readonly id: string;
  readonly name: string | null;
  readonly directory: string;
  readonly state: AgentLifecycleState;
  readonly createdAt: number;
  readonly birthSessionId: string | null;
  readonly restoreTarget: PersistedRestoreTarget | null;
  /** Written only when declared, so a store without declarations serializes exactly as before. See `persistMcp`. */
  readonly mcp?: readonly PersistedMcpServer[];
}

interface PersistedLaunchRecord {
  readonly attemptId: string;
  readonly agentId: string;
  readonly key: string;
  readonly attemptKey: PersistedAttemptKey | null;
  readonly attemptedAt: number;
  readonly launchShortId: string | null;
  readonly error: string | null;
}

interface PersistedPendingCreationRecord {
  readonly attemptId: string;
  readonly key: string;
  readonly launchShortId: string;
  readonly attemptedAt: number;
}

interface PersistedAgentStore {
  readonly version: typeof AGENT_STORE_VERSION;
  readonly agents: { readonly [id: string]: PersistedAgentRecord };
  readonly retiredIds: readonly string[];
  readonly launches: readonly PersistedLaunchRecord[];
  readonly restoreAttemptCounts: { readonly [agentId: string]: number };
  readonly pendingCreations: readonly PersistedPendingCreationRecord[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const LIFECYCLE_STATES: readonly AgentLifecycleState[] = ["on", "off", "archived"];

function isValidPersistedRestoreTarget(value: unknown): value is PersistedRestoreTarget {
  return isPlainObject(value) && typeof value["sessionId"] === "string" && typeof value["shortId"] === "string";
}

function isValidPersistedAttemptKey(value: unknown): value is PersistedAttemptKey {
  return (
    isPlainObject(value) &&
    (value["kind"] === "respawn" || value["kind"] === "forkFrom") &&
    (value["shortId"] === null || typeof value["shortId"] === "string") &&
    (value["sessionId"] === null || typeof value["sessionId"] === "string")
  );
}

function isValidPersistedAgentRecord(value: unknown): value is PersistedAgentRecord {
  return (
    isPlainObject(value) &&
    typeof value["id"] === "string" &&
    (value["name"] === null || typeof value["name"] === "string") &&
    typeof value["directory"] === "string" &&
    typeof value["state"] === "string" &&
    LIFECYCLE_STATES.includes(value["state"] as AgentLifecycleState) &&
    typeof value["createdAt"] === "number" &&
    (value["birthSessionId"] === null || typeof value["birthSessionId"] === "string") &&
    (value["restoreTarget"] === null || isValidPersistedRestoreTarget(value["restoreTarget"])) &&
    (value["mcp"] === undefined || isValidMcpDeclaration(value["mcp"]))
  );
}

/**
 * One declared server as stored. `notifications` is always written, because
 * builds from before channels were on by default require it and read it
 * correctly. But in THIS build only `quiet` opts a server out: under the old
 * syntax a stored `notifications: false` meant "never asked for +notify", not
 * "opted out", and channels are now on for every server unless opted out.
 */
interface PersistedMcpServer {
  readonly name: string;
  readonly notifications: boolean;
  readonly quiet?: boolean;
}

function isValidMcpDeclaration(value: unknown): value is readonly PersistedMcpServer[] {
  return Array.isArray(value) && value.every((server) =>
    isPlainObject(server) && typeof server["name"] === "string" && typeof server["notifications"] === "boolean" &&
    (server["quiet"] === undefined || typeof server["quiet"] === "boolean"));
}

const persistMcp = (servers: readonly McpServerDeclaration[]): PersistedMcpServer[] =>
  servers.map((server) => ({ name: server.name, notifications: server.notifications, ...(server.notifications ? {} : { quiet: true }) }));

const reviveMcp = (servers: readonly PersistedMcpServer[]): McpServerDeclaration[] =>
  servers.map((server) => ({ name: server.name, notifications: server.quiet !== true }));

function isValidPersistedLaunchRecord(value: unknown): value is PersistedLaunchRecord {
  return (
    isPlainObject(value) &&
    typeof value["attemptId"] === "string" &&
    typeof value["agentId"] === "string" &&
    typeof value["key"] === "string" &&
    (value["attemptKey"] === null || isValidPersistedAttemptKey(value["attemptKey"])) &&
    typeof value["attemptedAt"] === "number" &&
    (value["launchShortId"] === null || typeof value["launchShortId"] === "string") &&
    (value["error"] === null || typeof value["error"] === "string")
  );
}

function isValidRestoreAttemptCounts(value: unknown): value is Record<string, number> {
  if (!isPlainObject(value)) return false;
  return Object.values(value).every((v) => typeof v === "number");
}

function isValidRetiredIds(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isValidPersistedPendingCreationRecord(value: unknown): value is PersistedPendingCreationRecord {
  return (
    isPlainObject(value) &&
    typeof value["attemptId"] === "string" &&
    typeof value["key"] === "string" &&
    typeof value["launchShortId"] === "string" &&
    typeof value["attemptedAt"] === "number"
  );
}

function persistAttemptKey(key: AttemptKey | undefined): PersistedAttemptKey | null {
  if (key === undefined) return null;
  return key.kind === "respawn" ? { kind: "respawn", shortId: key.shortId, sessionId: null } : { kind: "forkFrom", shortId: null, sessionId: key.sessionId };
}

function reviveAttemptKey(value: PersistedAttemptKey | null): AttemptKey | undefined {
  if (value === null) return undefined;
  if (value.kind === "respawn") {
    if (value.shortId === null) throw new Error("attemptKey kind 'respawn' with no shortId");
    return { kind: "respawn", shortId: value.shortId };
  }
  if (value.sessionId === null) throw new Error("attemptKey kind 'forkFrom' with no sessionId");
  return { kind: "forkFrom", sessionId: value.sessionId };
}

export function serializeAgentStoreState(state: AgentStoreState): string {
  const agents: Record<string, PersistedAgentRecord> = {};
  for (const [id, a] of Object.entries(state.agents)) {
    agents[id] = {
      id: a.id,
      name: a.name ?? null,
      directory: a.directory,
      state: a.state,
      createdAt: a.createdAt,
      birthSessionId: a.birthSessionId ?? null,
      restoreTarget: a.restoreTarget ?? null,
      ...(a.mcp === undefined ? {} : { mcp: persistMcp(a.mcp) }),
    };
  }
  const launches: PersistedLaunchRecord[] = state.launches.map((l) => ({
    attemptId: l.attemptId,
    agentId: l.agentId,
    key: l.key,
    attemptKey: persistAttemptKey(l.attemptKey),
    attemptedAt: l.attemptedAt,
    launchShortId: l.launchShortId ?? null,
    error: l.error ?? null,
  }));
  const pendingCreations: PersistedPendingCreationRecord[] = state.pendingCreations.map((p) => ({
    attemptId: p.attemptId,
    key: p.key,
    launchShortId: p.launchShortId,
    attemptedAt: p.attemptedAt,
  }));
  const persisted: PersistedAgentStore = {
    version: AGENT_STORE_VERSION,
    agents,
    retiredIds: [...state.retiredIds],
    launches,
    restoreAttemptCounts: state.restoreAttemptCounts,
    pendingCreations,
  };
  return JSON.stringify(persisted, null, 2);
}

export type ParseResult = { readonly ok: true; readonly state: AgentStoreState } | { readonly ok: false; readonly error: string };

/**
 * BAKR-22 MIGRATION, pure (no I/O — the store-shape half only; see this
 * function's own doc for what it deliberately does NOT attempt to verify).
 * `sessionId.slice(0, 8)` matches the short id `claude` itself uses for a
 * job's own directory name — measured 58/58 on one host and 56/56
 * independently on another (both recorded on BAKR-22's ticket) — but it is
 * an OBSERVED, UNDOCUMENTED pattern, not a guarantee, so it is used ONLY
 * here, as a migration fallback, never for a normal write (every ordinary
 * `restoreTarget`/`attemptKey` write gets its short id from an actual
 * `launch()`/`respawn` result). If the derived id is wrong, the first
 * `respawn` attempt against it fails with claude's own "No job matching"
 * message — an UNRECOGNISED failure under this ticket's own rule, so it
 * refuses loudly rather than silently forking; see `planRestore`'s doc and
 * daemon.ts's dispatch. That is the "verification" this migration relies
 * on: not performed here, but guaranteed to surface loudly at the next
 * real restore attempt rather than being silently trusted.
 */
function deriveShortIdFromSessionId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

interface PersistedAgentRecordV1 {
  readonly id: string;
  readonly name: string | null;
  readonly directory: string;
  readonly state: AgentLifecycleState;
  readonly createdAt: number;
  readonly durableSessionId: string | null;
  readonly liveSessionId: string | null;
}

interface PersistedLaunchRecordV1 {
  readonly attemptId: string;
  readonly agentId: string;
  readonly key: string;
  readonly priorSessionId: string | null;
  readonly attemptedAt: number;
  readonly launchShortId: string | null;
  readonly error: string | null;
}

function isValidPersistedAgentRecordV1(value: unknown): value is PersistedAgentRecordV1 {
  return (
    isPlainObject(value) &&
    typeof value["id"] === "string" &&
    (value["name"] === null || typeof value["name"] === "string") &&
    typeof value["directory"] === "string" &&
    typeof value["state"] === "string" &&
    LIFECYCLE_STATES.includes(value["state"] as AgentLifecycleState) &&
    typeof value["createdAt"] === "number" &&
    (value["durableSessionId"] === null || typeof value["durableSessionId"] === "string") &&
    (value["liveSessionId"] === null || typeof value["liveSessionId"] === "string")
  );
}

function isValidPersistedLaunchRecordV1(value: unknown): value is PersistedLaunchRecordV1 {
  return (
    isPlainObject(value) &&
    typeof value["attemptId"] === "string" &&
    typeof value["agentId"] === "string" &&
    typeof value["key"] === "string" &&
    (value["priorSessionId"] === null || typeof value["priorSessionId"] === "string") &&
    typeof value["attemptedAt"] === "number" &&
    (value["launchShortId"] === null || typeof value["launchShortId"] === "string") &&
    (value["error"] === null || typeof value["error"] === "string")
  );
}

/**
 * ONE agent record, V1 (`durableSessionId`/`liveSessionId`) in, V2
 * (`birthSessionId`/`restoreTarget`) out. `birthSessionId` is a direct
 * carry of `durableSessionId` — birth provenance never needed a rule
 * change. `restoreTarget` prefers `liveSessionId` over `durableSessionId`
 * when both are present and differ — THE SUBTLE CASE the epic asked this
 * migration to argue: a v1 record whose `liveSessionId` is a 2.1.251-era
 * FORK of its `durableSessionId` (the exact defect this ticket measured:
 * `resolveLaunch`'s old restore branch updated only `liveSessionId`,
 * leaving `durableSessionId` pinned at birth). `liveSessionId` is the MORE
 * RECENT of the two in every such case — it is what the agent's last
 * successful restore actually resolved to — so it is the correct choice
 * for "what do I restore next", exactly mirroring `forkFrom`'s own rule of
 * always advancing from the current target, never back to birth. A record
 * with no session at all yet (`durableSessionId` and `liveSessionId` both
 * absent — e.g. a fresh launch that never resolved) gets no
 * `restoreTarget` either; `planRestore` already treats that as `fresh`.
 */
function migrateV1AgentRecord(v1: PersistedAgentRecordV1): PersistedAgentRecord {
  const restoreSessionId = v1.liveSessionId ?? v1.durableSessionId;
  return {
    id: v1.id,
    name: v1.name,
    directory: v1.directory,
    state: v1.state,
    createdAt: v1.createdAt,
    birthSessionId: v1.durableSessionId,
    restoreTarget: restoreSessionId === null ? null : { sessionId: restoreSessionId, shortId: deriveShortIdFromSessionId(restoreSessionId) },
  };
}

/**
 * ONE launch record, V1 (`priorSessionId`, always a durable/full session
 * id or absent) in, V2 (`attemptKey`, tagged by kind) out. Every v1
 * restore attempt becomes a `respawn`-kind key on the SAME derived short
 * id `migrateV1AgentRecord` would derive for that same session id — so a
 * migrated give-up record and the agent's own migrated `restoreTarget`
 * agree on the short id they key against, and B13's "give-up stays a
 * give-up until an operator clears it" property survives the migration
 * unchanged. A v1 fresh-launch attempt (`priorSessionId` absent) stays a
 * fresh (`undefined`) attempt key.
 */
function migrateV1LaunchRecord(v1: PersistedLaunchRecordV1): PersistedLaunchRecord {
  return {
    attemptId: v1.attemptId,
    agentId: v1.agentId,
    key: v1.key,
    attemptKey: v1.priorSessionId === null ? null : { kind: "respawn", shortId: deriveShortIdFromSessionId(v1.priorSessionId), sessionId: null },
    attemptedAt: v1.attemptedAt,
    launchShortId: v1.launchShortId,
    error: v1.error,
  };
}

/**
 * Pure parse: text in, typed result out, never throws. Mirrors
 * claim-model.ts / session-slots.ts exactly in discipline — a malformed or
 * foreign-shaped store is reported as an error, never silently coerced to
 * empty (this file is in the identical unreconstructable-from-nothing
 * position both of those are in; see agent-store-io.ts for where that
 * decision is enforced). Accepts BOTH `version: 2` (current) and
 * `version: 1` (BAKR-16/BAKR-19-era, pre-BAKR-22) — a v1 store is migrated
 * in place, in memory, via `migrateV1AgentRecord`/`migrateV1LaunchRecord`
 * above, and the NEXT save writes it back out as v2 (agent-store-io.ts's
 * `save` always serializes the current version). Any other version, or a
 * store that fails validation even after recognizing its version, is
 * malformed — never silently coerced.
 */
/**
 * A launch short id as recorded, with any terminal escapes removed. Builds
 * before the FORCE_COLOR fix (spawn/parse.ts's `stripAnsi`) recorded ids
 * such as `\x1b[36m52155a5f\x1b[39m\x1b[2m`, which no listing ever matches,
 * leaving the launch pending and its agent "on — not listed" forever.
 * Repairing on load resolves such a record against the listing like any
 * other, with no migration step; a clean id is returned unchanged.
 */
function repairStoredShortId<T extends string | undefined>(id: T): T {
  return (id === undefined ? id : stripAnsi(id)) as T;
}

export function parseAgentStoreState(source: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (err) {
    return { ok: false, error: `agent store is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!isPlainObject(parsed) || (parsed["version"] !== AGENT_STORE_VERSION && parsed["version"] !== 1) || !isPlainObject(parsed["agents"]) || !Array.isArray(parsed["launches"])) {
    return {
      ok: false,
      error: "agent store does not have the expected { version: 1 | 2, agents: {...}, retiredIds: [...], launches: [...], restoreAttemptCounts: {...} } shape",
    };
  }
  const isV1 = parsed["version"] === 1;

  const retiredIdsField = parsed["retiredIds"];
  if (retiredIdsField !== undefined && !isValidRetiredIds(retiredIdsField)) {
    return { ok: false, error: "agent store's retiredIds is present but is not an array of strings" };
  }

  const restoreAttemptCountsField = parsed["restoreAttemptCounts"];
  if (restoreAttemptCountsField !== undefined && !isValidRestoreAttemptCounts(restoreAttemptCountsField)) {
    return { ok: false, error: "agent store's restoreAttemptCounts is present but is not a { [agentId]: number } map" };
  }

  const pendingCreationsField = parsed["pendingCreations"];
  if (pendingCreationsField !== undefined && !Array.isArray(pendingCreationsField)) {
    return { ok: false, error: "agent store's pendingCreations is present but is not an array" };
  }

  const agents: Record<string, AgentRecord> = {};
  for (const [id, rawValue] of Object.entries(parsed["agents"])) {
    if (isV1) {
      if (!isValidPersistedAgentRecordV1(rawValue)) {
        return { ok: false, error: `agent entry "${id}" does not have the expected v1 AgentRecord shape: ${JSON.stringify(rawValue)}` };
      }
      const value = migrateV1AgentRecord(rawValue);
      agents[id] = {
        id: value.id,
        name: value.name ?? undefined,
        directory: value.directory as ClaimKey,
        state: value.state,
        createdAt: value.createdAt,
        birthSessionId: value.birthSessionId ?? undefined,
        restoreTarget: value.restoreTarget ?? undefined,
      };
      continue;
    }
    if (!isValidPersistedAgentRecord(rawValue)) {
      return { ok: false, error: `agent entry "${id}" does not have the expected AgentRecord shape: ${JSON.stringify(rawValue)}` };
    }
    agents[id] = {
      id: rawValue.id,
      name: rawValue.name ?? undefined,
      directory: rawValue.directory as ClaimKey,
      state: rawValue.state,
      createdAt: rawValue.createdAt,
      birthSessionId: rawValue.birthSessionId ?? undefined,
      restoreTarget: rawValue.restoreTarget ?? undefined,
      ...(rawValue.mcp === undefined ? {} : { mcp: reviveMcp(rawValue.mcp) }),
    };
  }

  const launches: LaunchRecord[] = [];
  for (const rawValue of parsed["launches"]) {
    if (isV1) {
      if (!isValidPersistedLaunchRecordV1(rawValue)) {
        return { ok: false, error: `a launch record in the agent store does not have the expected v1 shape: ${JSON.stringify(rawValue)}` };
      }
      const value = migrateV1LaunchRecord(rawValue);
      launches.push({
        attemptId: value.attemptId,
        agentId: value.agentId,
        key: value.key as ClaimKey,
        attemptKey: reviveAttemptKey(value.attemptKey),
        attemptedAt: value.attemptedAt,
        launchShortId: repairStoredShortId(value.launchShortId ?? undefined),
        error: value.error ?? undefined,
      });
      continue;
    }
    if (!isValidPersistedLaunchRecord(rawValue)) {
      return { ok: false, error: `a launch record in the agent store does not have the expected shape: ${JSON.stringify(rawValue)}` };
    }
    launches.push({
      attemptId: rawValue.attemptId,
      agentId: rawValue.agentId,
      key: rawValue.key as ClaimKey,
      attemptKey: reviveAttemptKey(rawValue.attemptKey),
      attemptedAt: rawValue.attemptedAt,
      launchShortId: repairStoredShortId(rawValue.launchShortId ?? undefined),
      error: rawValue.error ?? undefined,
    });
  }

  const pendingCreations: PendingCreationRecord[] = [];
  for (const value of (pendingCreationsField as unknown[] | undefined) ?? []) {
    if (!isValidPersistedPendingCreationRecord(value)) {
      return { ok: false, error: `a pendingCreations entry in the agent store does not have the expected shape: ${JSON.stringify(value)}` };
    }
    pendingCreations.push({ attemptId: value.attemptId, key: value.key as ClaimKey, launchShortId: repairStoredShortId(value.launchShortId), attemptedAt: value.attemptedAt });
  }

  return {
    ok: true,
    state: {
      agents,
      retiredIds: (retiredIdsField as string[] | undefined) ?? [],
      launches,
      restoreAttemptCounts: (restoreAttemptCountsField as Record<string, number> | undefined) ?? {},
      pendingCreations,
    },
  };
}
