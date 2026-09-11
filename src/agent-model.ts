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

export type AgentLifecycleState = "on" | "off" | "archived";

/**
 * `directory` and `name` are both attributes (B2/B4) — never the key. `id`
 * is the only field this store ever looks an agent up by internally;
 * `resolveAgent` below is the one function that accepts a directory-scoped
 * or global reference from a caller and translates it to one of these.
 */
export interface AgentRecord {
  readonly id: string;
  readonly name: string | undefined;
  readonly directory: ClaimKey;
  readonly state: AgentLifecycleState;
  readonly createdAt: number;
  readonly durableSessionId: string | undefined;
  readonly liveSessionId: string | undefined;
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
export interface LaunchRecord {
  readonly attemptId: string;
  readonly agentId: string;
  readonly key: ClaimKey;
  /** The DURABLE session id this launch was resuming, or `undefined` for a fresh launch. Never the live/rotated id. */
  readonly priorSessionId: string | undefined;
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

// --- Name rules (B4, B5, B11) -------------------------------------------

/** B5: a deliberate superset. If you add a word, say so in the PR — do not widen this list quietly. */
export const RESERVED_NAMES: readonly string[] = ["create", "attach", "on", "off", "name", "rename", "archive", "unarchive", "delete", "list", "adopt"];

/** B11: every refusal is typed and carries a message a surface can show verbatim. */
export type NameSyntaxResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "empty"; readonly message: string }
  | { readonly ok: false; readonly reason: "contains-at"; readonly message: string }
  | { readonly ok: false; readonly reason: "reserved"; readonly message: string };

/**
 * Syntax only — no filesystem, no store, no directory scope. `@` is refused
 * at EVERY position, not just leading (B3: "@" excluded from the name
 * charset entirely, so "a name collides with an id" cannot arise by
 * construction). Every reserved word (B5) is refused exactly, case-sensitive
 * — no fuzzy or case-insensitive matching, since none is specified and
 * inventing one would silently reserve more than the list says.
 */
export function validateNameSyntax(name: string): NameSyntaxResult {
  if (name.length === 0) {
    return { ok: false, reason: "empty", message: "a name must not be empty" };
  }
  if (name.includes("@")) {
    return { ok: false, reason: "contains-at", message: `a name must not contain "@" (found in "${name}") — "@" is reserved for agent ids` };
  }
  if (RESERVED_NAMES.includes(name)) {
    return { ok: false, reason: "reserved", message: `"${name}" is a reserved word and cannot be used as a name` };
  }
  return { ok: true };
}

export type NameAvailabilityResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "taken"; readonly message: string; readonly heldBy: AgentRecord };

/**
 * B4: names are unique within a claimed directory, not globally — the same
 * name in two directories is two different, unrelated names. Archived
 * agents keep holding their name (so a future unarchive can never collide);
 * only `delete` frees it (not shipped by this story). `excludingAgentId`
 * lets a future rename check availability without the agent colliding with
 * its own current name.
 */
export function checkNameAvailability(state: AgentStoreState, directory: ClaimKey, name: string, excludingAgentId?: string): NameAvailabilityResult {
  const holder = Object.values(state.agents).find((a) => a.directory === directory && a.name === name && a.id !== excludingAgentId);
  if (holder === undefined) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: "taken",
    message: `the name "${name}" is already held by ${holder.id} in this directory${holder.state === "archived" ? " (archived — archived agents keep their name)" : ""}`,
    heldBy: holder,
  };
}

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

// --- The resolver (B4, R-E) ----------------------------------------------

export type ResolveOutcome =
  | { readonly outcome: "found"; readonly agent: AgentRecord }
  | { readonly outcome: "found-elsewhere"; readonly agent: AgentRecord; readonly directory: ClaimKey }
  | { readonly outcome: "not-found" };

/**
 * `scope` has no default and no ambient fallback — it is impossible to call
 * this function without one (AC5), which is what makes B4's "the resolver's
 * directory scope is an explicit, required input" true by construction
 * rather than by convention.
 *
 * `ref` starting with "@" is treated as an id and resolved GLOBALLY: an id
 * belonging to another directory comes back as `found-elsewhere`, carrying
 * that directory, rather than either a false hit or an opaque miss — a
 * caller can then refuse or confirm intelligently (R-E). Any other `ref` is
 * treated as a name and resolved ONLY within `scope`: a name that exists in
 * a different directory is simply `not-found` — never a hit, never a
 * cross-directory suggestion masquerading as a resolution. This split is
 * unambiguous by construction: `validateNameSyntax` refuses "@" anywhere in
 * a name (B3), so a real name can never be mistaken for an id prefix.
 */
export function resolveAgent(state: AgentStoreState, scope: ClaimKey, ref: string): ResolveOutcome {
  if (ref.startsWith("@")) {
    const agent = state.agents[ref];
    if (agent === undefined) {
      return { outcome: "not-found" };
    }
    if (agent.directory !== scope) {
      return { outcome: "found-elsewhere", agent, directory: agent.directory };
    }
    return { outcome: "found", agent };
  }

  const agent = Object.values(state.agents).find((a) => a.directory === scope && a.name === ref);
  return agent === undefined ? { outcome: "not-found" } : { outcome: "found", agent };
}

// --- Which session to resume (BAKR-24 correction) -------------------------

/**
 * THE SINGLE FUNCTION every restore/adopt caller must go through to answer
 * "which session id do I pass `--resume`?" — never read `agent.durableSessionId`
 * inline at a call site. `durableSessionId` is correct and sufficient for now,
 * but BAKR-23 (a sibling story under the same epic) is going to change this
 * rule once it has measured which id a silently-failed restore can actually
 * resume (see this file's own header on the substrate's fork-on-resume
 * behaviour and the fact that a `--bg --resume` given no prompt writes NO
 * transcript at all). Funneling every caller through this one function is
 * what lets that future change land in one place instead of a hunt across
 * daemon.ts and every adoption/restore call site.
 */
export function sessionToResume(agent: AgentRecord): string | undefined {
  return agent.durableSessionId;
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

/** See session-slots.ts's own doc for why this must be called unconditionally on every load — identical reasoning, ported. */
export function promoteUnresolvableLaunches(state: AgentStoreState, reason: string): AgentStoreState {
  let next = state;
  for (const record of state.launches) {
    if (record.launchShortId === undefined && record.error === undefined) {
      next = markLaunchFailed(next, record.attemptId, reason);
    }
  }
  return next;
}

/**
 * True when a launch attempt for exactly this `(agentId, priorSessionId)`
 * pair already exists. Keyed by AGENT id now, not by directory — this is
 * what makes two agents launched fresh into the SAME directory in the SAME
 * cycle independent of one another (AC4): each has its own agent id, so
 * each gets its own guard entry, regardless of arrival order.
 */
export function hasLaunchRecordFor(state: AgentStoreState, agentId: string, priorSessionId: string | undefined): boolean {
  return state.launches.some((l) => l.agentId === agentId && l.priorSessionId === priorSessionId);
}

export function beginLaunch(state: AgentStoreState, agentId: string, key: ClaimKey, priorSessionId: string | undefined, attemptId: string, now: number): AgentStoreState {
  const record: LaunchRecord = { attemptId, agentId, key, priorSessionId, attemptedAt: now, launchShortId: undefined, error: undefined };
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
 * either way.
 *
 * - Fresh launch (`priorSessionId === undefined`): sets the agent's
 *   `durableSessionId`/`liveSessionId` to `resolvedSessionId`, but only if
 *   the agent does not already have a durable session id — idempotent
 *   against a duplicate resolution, and never overwrites an existing
 *   session the way BAKR-13's own regression forbids.
 * - Restore (`priorSessionId` defined — always a durable id): updates ONLY
 *   `liveSessionId`, and only when `priorSessionId` still matches the
 *   agent's own `durableSessionId` — `durableSessionId` itself is NEVER
 *   overwritten here (session-slots.ts's own hard-won fix, ported: this is
 *   what stopped the live restore-spawn loop).
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
  if (record.priorSessionId !== undefined) {
    if (agent.durableSessionId === record.priorSessionId) {
      nextAgent = { ...agent, liveSessionId: resolvedSessionId };
    }
  } else if (agent.durableSessionId === undefined) {
    nextAgent = { ...agent, durableSessionId: resolvedSessionId, liveSessionId: resolvedSessionId };
  }

  return { ...state, agents: { ...state.agents, [agent.id]: nextAgent }, launches };
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
    durableSessionId: resolvedSessionId,
    liveSessionId: resolvedSessionId,
  };
  return { ...state, agents: { ...state.agents, [id]: agent }, pendingCreations };
}

// --- Wire format -----------------------------------------------------

export const AGENT_STORE_VERSION = 1;

interface PersistedAgentRecord {
  readonly id: string;
  readonly name: string | null;
  readonly directory: string;
  readonly state: AgentLifecycleState;
  readonly createdAt: number;
  readonly durableSessionId: string | null;
  readonly liveSessionId: string | null;
}

interface PersistedLaunchRecord {
  readonly attemptId: string;
  readonly agentId: string;
  readonly key: string;
  readonly priorSessionId: string | null;
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

function isValidPersistedAgentRecord(value: unknown): value is PersistedAgentRecord {
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

function isValidPersistedLaunchRecord(value: unknown): value is PersistedLaunchRecord {
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

export function serializeAgentStoreState(state: AgentStoreState): string {
  const agents: Record<string, PersistedAgentRecord> = {};
  for (const [id, a] of Object.entries(state.agents)) {
    agents[id] = {
      id: a.id,
      name: a.name ?? null,
      directory: a.directory,
      state: a.state,
      createdAt: a.createdAt,
      durableSessionId: a.durableSessionId ?? null,
      liveSessionId: a.liveSessionId ?? null,
    };
  }
  const launches: PersistedLaunchRecord[] = state.launches.map((l) => ({
    attemptId: l.attemptId,
    agentId: l.agentId,
    key: l.key,
    priorSessionId: l.priorSessionId ?? null,
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
 * Pure parse: text in, typed result out, never throws. Mirrors
 * claim-model.ts / session-slots.ts exactly in discipline — a malformed or
 * foreign-shaped store is reported as an error, never silently coerced to
 * empty (this file is in the identical unreconstructable-from-nothing
 * position both of those are in; see agent-store-io.ts for where that
 * decision is enforced).
 */
export function parseAgentStoreState(source: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (err) {
    return { ok: false, error: `agent store is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!isPlainObject(parsed) || parsed["version"] !== AGENT_STORE_VERSION || !isPlainObject(parsed["agents"]) || !Array.isArray(parsed["launches"])) {
    return {
      ok: false,
      error: "agent store does not have the expected { version: 1, agents: {...}, retiredIds: [...], launches: [...], restoreAttemptCounts: {...} } shape",
    };
  }

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
  for (const [id, value] of Object.entries(parsed["agents"])) {
    if (!isValidPersistedAgentRecord(value)) {
      return { ok: false, error: `agent entry "${id}" does not have the expected AgentRecord shape: ${JSON.stringify(value)}` };
    }
    agents[id] = {
      id: value.id,
      name: value.name ?? undefined,
      directory: value.directory as ClaimKey,
      state: value.state,
      createdAt: value.createdAt,
      durableSessionId: value.durableSessionId ?? undefined,
      liveSessionId: value.liveSessionId ?? undefined,
    };
  }

  const launches: LaunchRecord[] = [];
  for (const value of parsed["launches"]) {
    if (!isValidPersistedLaunchRecord(value)) {
      return { ok: false, error: `a launch record in the agent store does not have the expected shape: ${JSON.stringify(value)}` };
    }
    launches.push({
      attemptId: value.attemptId,
      agentId: value.agentId,
      key: value.key as ClaimKey,
      priorSessionId: value.priorSessionId ?? undefined,
      attemptedAt: value.attemptedAt,
      launchShortId: value.launchShortId ?? undefined,
      error: value.error ?? undefined,
    });
  }

  const pendingCreations: PendingCreationRecord[] = [];
  for (const value of (pendingCreationsField as unknown[] | undefined) ?? []) {
    if (!isValidPersistedPendingCreationRecord(value)) {
      return { ok: false, error: `a pendingCreations entry in the agent store does not have the expected shape: ${JSON.stringify(value)}` };
    }
    pendingCreations.push({ attemptId: value.attemptId, key: value.key as ClaimKey, launchShortId: value.launchShortId, attemptedAt: value.attemptedAt });
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
