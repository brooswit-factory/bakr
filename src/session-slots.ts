// bakr's own layer for "which claude session ids should be running inside a
// claimed directory" (BAKR-12, implementing story BAKR-8's own §"The
// agentIds line"). Deliberately NOT claim-model.ts's `agentIds` field —
// that field ships no mutator anywhere in this codebase, on purpose, and
// this ticket is told explicitly not to grow claim-model.ts into a
// lifecycle module or add one. This is a separate, bakr-owned store, its
// own file, alongside the claim store under $XDG_STATE_HOME/bakr/ (see
// paths.ts / session-slots-store.ts).
//
// Kept to exactly what restore needs and nothing else: an ANONYMOUS
// collection of "slots" per claimed directory — no names, no user-visible
// ids, no on/off/archive/rename verbs, no per-agent metadata beyond the
// two raw identities below and the bookkeeping this module's own
// Constraint 2 handling requires (see LaunchRecord). The ticket's own word
// for this shape is "slots" — used here as the file's name, not as a
// euphemism for a lifecycle vocabulary.
//
// TWO ids per slot, not one — found necessary live (BAKR-12 PR #9,
// verified by the story on 2026-09-10): claude's own session identity
// splits into a DURABLE conversation id (the only thing `--resume` can
// reliably take — the reviewer's own live trace showed a resume of a
// FRESH resume's rotated id fail with "No conversation found", while
// resuming the ORIGINAL id kept succeeding even after already being
// resumed twice) and a LIVE session id (the ephemeral thing that shows up
// in `claude agents --json` right now, useful only for checking liveness
// this cycle). The two conflated into one field is what made the daemon's
// earlier restore-spawn loop possible in the first place: each successful
// restore overwrote the record with the just-rotated live id, which then
// could not itself be resumed, so the NEXT cycle found it absent and
// "restored" it again — round and round. `durableSessionId` is written
// once, at slot creation, and NEVER changes; `liveSessionId` is the only
// field a restore's resolution updates. Both remain claude's OWN ids
// (never bakr-minted), keeping bakr out of BAKR-2's durable-id design.
//
// Honest, disclosed limit carried over from the story's own finding: this
// split fixes the SPECIFIC observed failure (resuming a rotated id
// fails, resuming the original succeeds), not every possible one — the
// story's own live probing saw a rotated id resume successfully on a
// different occasion, so a slot's restorability may depend on some
// property of claude's own session handling neither this codebase nor the
// story has pinned down. When it goes the wrong way even for the durable
// id, Constraint 2's bounded-retry give-up (see daemon.ts) is still what
// catches it — this module does not claim to solve that deeper mystery.
//
// The wire format (parse/serialize) mirrors claim-model.ts's own section,
// which itself mirrors the versioned-envelope / pure-parse-never-throws
// shape brooswit-factory/candlestix uses in its src/registry.ts and
// src/agent-set.ts (verified at candlestix's own commit
// 3801992aae149271e273a3ee48247978b1df6e8c — see those files' own module
// comments) — ported as a *pattern*, not literal code, since the shapes
// differ.

import type { ClaimKey } from "./claim-key-resolve";

/**
 * One anonymous slot: a durable conversation id (what `--resume` takes,
 * fixed for the slot's whole life) and the last-known live session id
 * (what a listing reports right now, used only to check liveness). See
 * the module comment for why these are two fields, not one.
 */
export interface Slot {
  readonly durableSessionId: string;
  readonly liveSessionId: string;
}

/**
 * One launch attempt this daemon is responsible for, tracked from BEFORE
 * `launch()` is even called through to resolution — Constraint 2's "record
 * the intent to launch before invoking launch(), and persist it" (BAKR-8).
 * `attemptId` is this record's own opaque identity (a fresh random id,
 * minted by the caller), never a directory and never claude's session id —
 * it exists purely so a later cycle can find and finalize THIS attempt,
 * never to resolve an agent from a directory.
 *
 * Three states, tracked by which fields are set:
 * - in flight, not yet resolved: `launchShortId` and `error` both
 *   undefined. This is written to disk BEFORE `launch()` is called, so a
 *   daemon crash mid-launch (before `launch()` even returns) still leaves a
 *   durable trace — the exact gap Constraint 2 exists to close.
 * - launched, awaiting a listing that resolves its full session id:
 *   `launchShortId` set, `error` still undefined.
 * - permanently unresolved: `error` set. Never cleared automatically, never
 *   retried automatically, never resolved by matching `key` (the claimed
 *   directory) against a listing — Constraint 2 forbids the obvious "fix"
 *   (cwd-adoption) explicitly. There is deliberately no verb anywhere in
 *   this codebase that clears one; discharging it is left to a human, via
 *   whatever operator surface a later epic builds.
 */
export interface LaunchRecord {
  readonly attemptId: string;
  readonly key: ClaimKey;
  /** The DURABLE session id this launch was resuming (always what was passed to `--resume`), or `undefined` for a fresh launch (no prior session). Never the live/rotated id. */
  readonly priorSessionId: string | undefined;
  readonly attemptedAt: number;
  readonly launchShortId: string | undefined;
  readonly error: string | undefined;
}

export interface SessionSlotsState {
  readonly onByKey: { readonly [key: string]: readonly Slot[] };
  readonly launches: readonly LaunchRecord[];
  /**
   * Consecutive restore attempts for a claimed directory that have not yet
   * produced a verifiably-alive session — keyed by directory rather than by
   * session id, for the same churn reason the module comment above
   * explains for `Slot` itself: even with the durable/live split, a
   * directory-keyed counter is the more robust bound (it survives any
   * churn in either id) and it is what the story's own review asked for.
   */
  readonly restoreAttemptCounts: { readonly [key: string]: number };
}

export function emptySessionSlots(): SessionSlotsState {
  return { onByKey: {}, launches: [], restoreAttemptCounts: {} };
}

export function restoreAttemptCount(state: SessionSlotsState, key: ClaimKey): number {
  return state.restoreAttemptCounts[key] ?? 0;
}

export function recordRestoreAttempt(state: SessionSlotsState, key: ClaimKey): SessionSlotsState {
  return { ...state, restoreAttemptCounts: { ...state.restoreAttemptCounts, [key]: restoreAttemptCount(state, key) + 1 } };
}

/** Called once a session for `key` is independently verified alive — the saga that bounded retry exists to interrupt is over, so the next genuine failure gets the full budget again. A no-op (not merely harmless, structurally absent from the object) when there is nothing to reset. */
export function resetRestoreAttempts(state: SessionSlotsState, key: ClaimKey): SessionSlotsState {
  if (!(key in state.restoreAttemptCounts)) return state;
  const restoreAttemptCounts = { ...state.restoreAttemptCounts };
  delete restoreAttemptCounts[key];
  return { ...state, restoreAttemptCounts };
}

/** The full slot objects (durable + live id) for a claimed directory — what the daemon's own reconcile loop iterates. */
export function slotsOn(state: SessionSlotsState, key: ClaimKey): readonly Slot[] {
  return state.onByKey[key] ?? [];
}

/** Durable session ids only, for callers that just want "what's registered" (e.g. the demo harness's own status print). */
export function sessionsOn(state: SessionSlotsState, key: ClaimKey): readonly string[] {
  return slotsOn(state, key).map((s) => s.durableSessionId);
}

export function claimedKeysWithSlots(state: SessionSlotsState): readonly ClaimKey[] {
  return Object.keys(state.onByKey) as ClaimKey[];
}

/** Records still awaiting resolution one way or the other — either not yet launched-and-listed, or launched and waiting on a future listing to reveal the rotated session id. Never includes a permanently-unresolved (errored) record. */
export function pendingLaunches(state: SessionSlotsState): readonly LaunchRecord[] {
  return state.launches.filter((l) => l.error === undefined);
}

/** Constraint 2's "logs it at error level on every cycle" list — permanently unresolved, possibly-orphaned launches. Never auto-cleared, never auto-retried, never resolved by `key` alone. */
export function unresolvedLaunches(state: SessionSlotsState): readonly LaunchRecord[] {
  return state.launches.filter((l) => l.error !== undefined);
}

/**
 * Promotes every record still missing BOTH `launchShortId` and `error` to
 * permanently unresolved, with `reason` as its error.
 *
 * Such a record can only be produced by a crash between `beginLaunch`'s
 * own `saveSlots` and `launch()` returning (see daemon.ts) — the window is
 * not narrow: it spans the entire `launch()` call, a `systemd-run` + `claude
 * --bg` invocation with a real timeout. Without this promotion, that
 * record is a silent trap door: `pendingLaunches`' own consumer in
 * daemon.ts skips it forever (no `launchShortId` to look up in a listing),
 * `hasLaunchRecordFor` still matches it and blocks a fresh restore attempt
 * for the same session, and `unresolvedLaunches` excludes it (no `error`
 * yet) — so it is never resolvable, never restorable, and never logged.
 * That agent would silently never come back, on this boot or any future
 * one, found only by a human reading source rather than a log line.
 *
 * Safe to call unconditionally on every load (not only at true process
 * startup, see daemon.ts's own call site): a record legitimately in this
 * shape only ever exists in memory, mid-cycle, between `beginLaunch` and
 * its own `markLaunchStarted`/`markLaunchFailed` a few lines later in the
 * SAME cycle — the daemon loads the store once per cycle, at the start,
 * before any such record could exist yet. So any record already on disk in
 * this shape by the time a `load()` call sees it is necessarily left over
 * from a run that ended (crashed, was killed) before it could finish
 * recording the outcome — exactly Constraint 2's "cannot distinguish
 * never-detached from detached-then-the-wrapper-failed": there is no way
 * to know whether the launch actually happened, so — the safe direction —
 * it is treated as possibly orphaned and reported, never silently dropped
 * and never auto-retried (`markLaunchFailed` never clears; see that
 * function's own doc).
 */
export function promoteUnresolvableLaunches(state: SessionSlotsState, reason: string): SessionSlotsState {
  let next = state;
  for (const record of state.launches) {
    if (record.launchShortId === undefined && record.error === undefined) {
      next = markLaunchFailed(next, record.attemptId, reason);
    }
  }
  return next;
}

/**
 * True when a launch attempt for exactly this `(key, priorSessionId)` pair
 * already exists — whether still pending resolution or permanently
 * unresolved. `priorSessionId` here is always a DURABLE id (see
 * `LaunchRecord`'s own doc) — since a slot's durable id never changes, this
 * guard now correctly matches across cycles for the SAME slot even while
 * its live id churns, which is what actually stops the restore-spawn loop
 * found in review; the bounded-retry counter (`restoreAttemptCounts`) is
 * kept as a second, independent line of defence rather than removed.
 *
 * A caller deciding whether to restore a session must check this FIRST:
 * without it, a restore whose launch succeeded but is still awaiting a
 * listing to reveal its rotated live id (see `resolveLaunch`) would look,
 * cycle after cycle, exactly like a session that still needs restoring —
 * because the slot's live id does not update until resolution — and a
 * naive caller would launch a duplicate every cycle until resolution
 * catches up. The same check is what makes Constraint 2's "never retried
 * automatically" true for a permanently-failed attempt.
 */
export function hasLaunchRecordFor(state: SessionSlotsState, key: ClaimKey, priorSessionId: string): boolean {
  return state.launches.some((l) => l.key === key && l.priorSessionId === priorSessionId);
}

/**
 * Begins tracking a launch attempt BEFORE `launch()` is invoked — the
 * caller must persist the returned state to disk before calling `launch()`,
 * not after, for this to actually close Constraint 2's gap. Returns the
 * minted `attemptId` the caller must hand back to `markLaunchStarted` /
 * `markLaunchFailed` once `launch()` settles. `priorSessionId`, when given,
 * must be a slot's DURABLE id — this is what gets passed to `--resume`.
 */
export function beginLaunch(
  state: SessionSlotsState,
  key: ClaimKey,
  priorSessionId: string | undefined,
  attemptId: string,
  now: number
): SessionSlotsState {
  const record: LaunchRecord = { attemptId, key, priorSessionId, attemptedAt: now, launchShortId: undefined, error: undefined };
  const withRecord = { ...state, launches: [...state.launches, record] };
  // A FRESH launch (no priorSessionId — never the daemon's own restore
  // path, which always resumes a specific durable id) is a deliberate new
  // registration for this directory, e.g. via the demo harness. It gets a
  // clean retry budget rather than inheriting an exhausted count left by an
  // earlier, unrelated restore saga for the same key.
  return priorSessionId === undefined ? resetRestoreAttempts(withRecord, key) : withRecord;
}

function updateLaunch(state: SessionSlotsState, attemptId: string, update: (record: LaunchRecord) => LaunchRecord): SessionSlotsState {
  const index = state.launches.findIndex((l) => l.attemptId === attemptId);
  if (index === -1) return state;
  const launches = [...state.launches];
  launches[index] = update(launches[index] as LaunchRecord);
  return { ...state, launches };
}

/** `launch()` returned `{ok:true, id}` — the attempt is no longer purely-intent, but its full session id is still unknown until a later listing resolves it (see `resolveLaunch`). */
export function markLaunchStarted(state: SessionSlotsState, attemptId: string, launchShortId: string): SessionSlotsState {
  return updateLaunch(state, attemptId, (record) => ({ ...record, launchShortId }));
}

/** `launch()` returned `{ok:false}` — moves the record to permanently-unresolved. Never removed by this module; see the module doc on `LaunchRecord.error`. */
export function markLaunchFailed(state: SessionSlotsState, attemptId: string, error: string): SessionSlotsState {
  return updateLaunch(state, attemptId, (record) => ({ ...record, error }));
}

/**
 * A later listing found `launchShortId` with session id `resolvedSessionId`
 * — finalizes the matching pending record and removes it from `launches`.
 *
 * - Fresh launch (`priorSessionId === undefined`): creates a NEW slot with
 *   `durableSessionId === liveSessionId === resolvedSessionId` — at the
 *   moment of a fresh launch, the two identities are, definitionally, the
 *   same thing (no restore has happened yet to reveal a rotation). Skips
 *   creating a duplicate slot if one with this durable id already exists.
 * - Restore (`priorSessionId` defined — always a durable id): finds the
 *   slot whose `durableSessionId === priorSessionId` and updates ONLY its
 *   `liveSessionId` to `resolvedSessionId`. **`durableSessionId` is never
 *   overwritten here** — this is the fix for the live incident the module
 *   comment describes: overwriting it with a rotated id that might not
 *   itself be resumable is what caused the restore-spawn loop. If no
 *   matching slot is found (should not happen in normal operation — a
 *   defensive fallback, not an expected path), a new slot is created
 *   rather than the update being silently lost.
 *
 * A no-op if no pending record matches `launchShortId` — total, like
 * claim-model.ts's own mutators, rather than an error a reconcile cycle
 * would have to guard.
 */
export function resolveLaunch(state: SessionSlotsState, launchShortId: string, resolvedSessionId: string): SessionSlotsState {
  const record = state.launches.find((l) => l.launchShortId === launchShortId && l.error === undefined);
  if (record === undefined) return state;

  const launches = state.launches.filter((l) => l.attemptId !== record.attemptId);
  const existing = slotsOn(state, record.key);

  let next: readonly Slot[];
  if (record.priorSessionId !== undefined) {
    const index = existing.findIndex((s) => s.durableSessionId === record.priorSessionId);
    next =
      index === -1
        ? [...existing, { durableSessionId: record.priorSessionId, liveSessionId: resolvedSessionId }]
        : existing.map((s, i) => (i === index ? { ...s, liveSessionId: resolvedSessionId } : s));
  } else {
    next = existing.some((s) => s.durableSessionId === resolvedSessionId)
      ? existing
      : [...existing, { durableSessionId: resolvedSessionId, liveSessionId: resolvedSessionId }];
  }

  return { ...state, onByKey: { ...state.onByKey, [record.key]: next }, launches };
}

// --- Wire format -----------------------------------------------------

export const SESSION_SLOTS_VERSION = 1;

interface PersistedLaunchRecord {
  readonly attemptId: string;
  readonly key: string;
  readonly priorSessionId: string | null;
  readonly attemptedAt: number;
  readonly launchShortId: string | null;
  readonly error: string | null;
}

interface PersistedSlot {
  readonly durableSessionId: string;
  readonly liveSessionId: string;
}

interface PersistedSessionSlots {
  readonly version: typeof SESSION_SLOTS_VERSION;
  readonly onByKey: { readonly [key: string]: readonly PersistedSlot[] };
  readonly launches: readonly PersistedLaunchRecord[];
  readonly restoreAttemptCounts: { readonly [key: string]: number };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidPersistedSlot(value: unknown): value is PersistedSlot {
  return isPlainObject(value) && typeof value["durableSessionId"] === "string" && typeof value["liveSessionId"] === "string";
}

/**
 * Accepts EITHER the current per-entry shape (`{durableSessionId,
 * liveSessionId}`) OR the legacy pre-durable/live-split shape (a bare
 * session id string, written by every build up to and including PR #8) —
 * a legacy string `s` is treated as `{durableSessionId: s, liveSessionId:
 * s}`, which is exactly what that string meant before this split existed.
 * Applying the SAME lesson the previous review round taught (a routine
 * upgrade must not trip Constraint 3's malformed path over a field whose
 * old value has an obvious, correct reading in the new shape) — proactively
 * this time, rather than after another live incident. `serializeSessionSlotsState`
 * always writes the current shape; this is read-compat only, one direction.
 */
function normalizeSlotEntry(value: unknown): Slot | undefined {
  if (typeof value === "string") {
    return { durableSessionId: value, liveSessionId: value };
  }
  if (isValidPersistedSlot(value)) {
    return value;
  }
  return undefined;
}

function isValidRestoreAttemptCounts(value: unknown): value is Record<string, number> {
  if (!isPlainObject(value)) return false;
  return Object.values(value).every((v) => typeof v === "number");
}

function isValidPersistedLaunchRecord(value: unknown): value is PersistedLaunchRecord {
  return (
    isPlainObject(value) &&
    typeof value["attemptId"] === "string" &&
    typeof value["key"] === "string" &&
    (value["priorSessionId"] === null || typeof value["priorSessionId"] === "string") &&
    typeof value["attemptedAt"] === "number" &&
    (value["launchShortId"] === null || typeof value["launchShortId"] === "string") &&
    (value["error"] === null || typeof value["error"] === "string")
  );
}

export function serializeSessionSlotsState(state: SessionSlotsState): string {
  const launches: PersistedLaunchRecord[] = state.launches.map((l) => ({
    attemptId: l.attemptId,
    key: l.key,
    priorSessionId: l.priorSessionId ?? null,
    attemptedAt: l.attemptedAt,
    launchShortId: l.launchShortId ?? null,
    error: l.error ?? null,
  }));
  const onByKey: Record<string, PersistedSlot[]> = {};
  for (const [key, slots] of Object.entries(state.onByKey)) {
    onByKey[key] = slots.map((s) => ({ durableSessionId: s.durableSessionId, liveSessionId: s.liveSessionId }));
  }
  const persisted: PersistedSessionSlots = {
    version: SESSION_SLOTS_VERSION,
    onByKey,
    launches,
    restoreAttemptCounts: state.restoreAttemptCounts,
  };
  return JSON.stringify(persisted, null, 2);
}

export type ParseResult = { readonly ok: true; readonly state: SessionSlotsState } | { readonly ok: false; readonly error: string };

/**
 * Pure parse: text in, typed result out, never throws. Mirrors
 * claim-model.ts's `parseClaimStoreState` exactly in discipline: a
 * malformed or foreign-shaped file is reported as an error, never silently
 * coerced to empty — this file is exactly as unreconstructable as the claim
 * store (nothing in bakr may resolve a session from a directory alone, so
 * there is no live oracle to rebuild it from either), so collapsing
 * "malformed" into "empty" here would carry the same data-loss hazard
 * Constraint 3 names for the claim store. See session-slots-store.ts for
 * where that decision is actually enforced.
 */
export function parseSessionSlotsState(source: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (err) {
    return { ok: false, error: `session slots store is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }

  // `restoreAttemptCounts` is OPTIONAL in the persisted shape, deliberately
  // (review, PR #8 round 2): it was added after SESSION_SLOTS_VERSION 1
  // already shipped (merged in PR #7), and a field whose absence has an
  // obvious, correct default — zero attempts recorded for every key — must
  // not turn an ordinary version-1-to-version-1 upgrade into Constraint 3's
  // "malformed" path, which would silently disable restore entirely and
  // freeze writes until a human hand-edits the file. A PRESENT-but-wrong
  // value (not an object of numbers) is still rejected as malformed below
  // — this is a default for absence, not a loosening of the shape check.
  const restoreAttemptCountsField = isPlainObject(parsed) ? parsed["restoreAttemptCounts"] : undefined;
  const onByKeyRaw = isPlainObject(parsed) ? parsed["onByKey"] : undefined;
  const onByKeyShapeOk = isPlainObject(onByKeyRaw) && Object.values(onByKeyRaw).every((v) => Array.isArray(v));

  if (
    !isPlainObject(parsed) ||
    parsed["version"] !== SESSION_SLOTS_VERSION ||
    !onByKeyShapeOk ||
    !Array.isArray(parsed["launches"]) ||
    (restoreAttemptCountsField !== undefined && !isValidRestoreAttemptCounts(restoreAttemptCountsField))
  ) {
    return {
      ok: false,
      error:
        "session slots store does not have the expected { version: 1, onByKey: {...}, launches: [...], restoreAttemptCounts?: {...} } shape",
    };
  }

  const onByKey: Record<string, Slot[]> = {};
  for (const [key, rawSlots] of Object.entries(onByKeyRaw as Record<string, unknown[]>)) {
    const slots: Slot[] = [];
    for (const rawSlot of rawSlots) {
      const normalized = normalizeSlotEntry(rawSlot);
      if (normalized === undefined) {
        return { ok: false, error: `an on-set entry for "${key}" does not have the expected shape: ${JSON.stringify(rawSlot)}` };
      }
      slots.push(normalized);
    }
    onByKey[key] = slots;
  }

  const launches: LaunchRecord[] = [];
  for (const value of parsed["launches"]) {
    if (!isValidPersistedLaunchRecord(value)) {
      return { ok: false, error: `a launch record in the session slots store does not have the expected shape: ${JSON.stringify(value)}` };
    }
    launches.push({
      attemptId: value.attemptId,
      key: value.key as ClaimKey,
      priorSessionId: value.priorSessionId ?? undefined,
      attemptedAt: value.attemptedAt,
      launchShortId: value.launchShortId ?? undefined,
      error: value.error ?? undefined,
    });
  }

  return {
    ok: true,
    state: { onByKey, launches, restoreAttemptCounts: (restoreAttemptCountsField as Record<string, number> | undefined) ?? {} },
  };
}
