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
// collection of claude's own session ids per claimed directory — no names,
// no user-visible ids, no on/off/archive/rename verbs, no per-agent
// metadata beyond the raw identity and the bookkeeping this module's own
// Constraint 2 handling requires (see LaunchRecord below). The ticket's own
// word for this shape is "slots" — used here as the file's name, not as a
// euphemism for a lifecycle vocabulary.
//
// A session id here is claude's OWN identity (the full UUID
// spawn/parse.ts's BackgroundSessionInfo.sessionId reports), never a
// bakr-minted one — this is what keeps bakr out of BAKR-2's durable-id
// design entirely, per the ticket's own steer.
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
  /** The session id this launch was resuming, or `undefined` for a fresh launch (no prior session). */
  readonly priorSessionId: string | undefined;
  readonly attemptedAt: number;
  readonly launchShortId: string | undefined;
  readonly error: string | undefined;
}

export interface SessionSlotsState {
  readonly onByKey: { readonly [key: string]: readonly string[] };
  readonly launches: readonly LaunchRecord[];
}

export function emptySessionSlots(): SessionSlotsState {
  return { onByKey: {}, launches: [] };
}

export function sessionsOn(state: SessionSlotsState, key: ClaimKey): readonly string[] {
  return state.onByKey[key] ?? [];
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
 * True when a launch attempt for exactly this `(key, priorSessionId)` pair
 * already exists — whether still pending resolution or permanently
 * unresolved. A caller deciding whether to restore a session must check
 * this FIRST: without it, a restore whose launch succeeded but is still
 * awaiting a listing to reveal its rotated session id (see `resolveLaunch`)
 * would look, cycle after cycle, exactly like a session that still needs
 * restoring — because `onByKey` does not get updated until resolution — and
 * a naive caller would launch a duplicate every cycle until resolution
 * catches up. The same check is what makes Constraint 2's "never retried
 * automatically" true for a permanently-failed attempt, for the identical
 * reason: `priorSessionId` never left `onByKey` after a failure either.
 */
export function hasLaunchRecordFor(state: SessionSlotsState, key: ClaimKey, priorSessionId: string): boolean {
  return state.launches.some((l) => l.key === key && l.priorSessionId === priorSessionId);
}

/**
 * Begins tracking a launch attempt BEFORE `launch()` is invoked — the
 * caller must persist the returned state to disk before calling `launch()`,
 * not after, for this to actually close Constraint 2's gap. Returns the
 * minted `attemptId` the caller must hand back to `markLaunchStarted` /
 * `markLaunchFailed` once `launch()` settles.
 */
export function beginLaunch(
  state: SessionSlotsState,
  key: ClaimKey,
  priorSessionId: string | undefined,
  attemptId: string,
  now: number
): SessionSlotsState {
  const record: LaunchRecord = { attemptId, key, priorSessionId, attemptedAt: now, launchShortId: undefined, error: undefined };
  return { ...state, launches: [...state.launches, record] };
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
 * Re-verified live on this workspace (claude 2.1.267, 2026-09-10, BAKR-12):
 * the ticket's own measurement 4 says a resume always rotates to a NEW
 * session id. A live restore-after-stop cycle run here reproduced that
 * once (old id -> a different new id), but a second one — resuming a
 * session that had been cleanly `claude stop`-ped — resolved back to the
 * SAME session id it started with, matching the `--help` text's own
 * wording more closely ("continues that session ... under the same ID, or
 * starts a copy"). This function does not need to care which happens: the
 * branch below is a no-op when `resolvedSessionId === priorSessionId`
 * (`existing.map` replaces the old id with the identical value), so both
 * outcomes are handled correctly without any special-casing.
 *
 * A later listing found `launchShortId` with session id `resolvedSessionId`
 * — finalizes the matching pending record: removes it from `launches`, and
 * either REPLACES `priorSessionId` with `resolvedSessionId` in `onByKey`
 * (the restore/rotation case — session ids rotate on every resume, so the
 * stale id must not linger) or, when `priorSessionId` is `undefined` (a
 * fresh launch), ADDS `resolvedSessionId` to `onByKey[key]`. A no-op if no
 * pending record matches `launchShortId` — total, like claim-model.ts's own
 * mutators, rather than an error a reconcile cycle would have to guard.
 */
export function resolveLaunch(state: SessionSlotsState, launchShortId: string, resolvedSessionId: string): SessionSlotsState {
  const record = state.launches.find((l) => l.launchShortId === launchShortId && l.error === undefined);
  if (record === undefined) return state;

  const launches = state.launches.filter((l) => l.attemptId !== record.attemptId);
  const existing = state.onByKey[record.key] ?? [];
  const next =
    record.priorSessionId !== undefined
      ? existing.includes(record.priorSessionId)
        ? existing.map((id) => (id === record.priorSessionId ? resolvedSessionId : id))
        : existing.includes(resolvedSessionId)
          ? existing
          : [...existing, resolvedSessionId]
      : existing.includes(resolvedSessionId)
        ? existing
        : [...existing, resolvedSessionId];

  return { onByKey: { ...state.onByKey, [record.key]: next }, launches };
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

interface PersistedSessionSlots {
  readonly version: typeof SESSION_SLOTS_VERSION;
  readonly onByKey: { readonly [key: string]: readonly string[] };
  readonly launches: readonly PersistedLaunchRecord[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidOnByKey(value: unknown): value is Record<string, readonly string[]> {
  if (!isPlainObject(value)) return false;
  return Object.values(value).every((v) => Array.isArray(v) && v.every((id) => typeof id === "string"));
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
  const persisted: PersistedSessionSlots = { version: SESSION_SLOTS_VERSION, onByKey: state.onByKey, launches };
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

  if (
    !isPlainObject(parsed) ||
    parsed["version"] !== SESSION_SLOTS_VERSION ||
    !isValidOnByKey(parsed["onByKey"]) ||
    !Array.isArray(parsed["launches"])
  ) {
    return {
      ok: false,
      error: "session slots store does not have the expected { version: 1, onByKey: {...}, launches: [...] } shape",
    };
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

  return { ok: true, state: { onByKey: parsed["onByKey"], launches } };
}
