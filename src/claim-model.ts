// The pure claim-store core (BAKR-10): plain functions over plain data.
// No filesystem, clock, env, or daemon coupling in the logic itself — the
// current time (`now`) and the already-normalized key are always
// parameters, never read from ambient state.
//
// Idempotence is the shape of "no init step" (there is no register/init
// verb anywhere in bakr's API, by the human's own decision): claiming an
// already-claimed path succeeds and returns the EXISTING claim unchanged
// — same `claimedAt`, same `agentIds` — it never errors and never
// re-stamps the timestamp. See claim-model.test.ts for the test that
// proves the timestamp does not move on a second claim.
//
// `agentIds` is a *collection*, deliberately, and deliberately has no
// mutator anywhere in this module. Two things are true together:
//   1. The project-wide constraint — "nothing in bakr may resolve, adopt,
//      or reconcile an agent by cwd alone; a claim holds a collection of
//      agents, never one, even when there happens to be one" — has to be
//      true by construction, not by a convention someone has to
//      remember. A list-shaped field makes it so even before anything
//      populates it.
//   2. *How* an id gets added, removed, or reconciled is agent-lifecycle
//      design (create/attach/on/off/archive) — BAKR-2's scope, not this
//      ticket's. This ticket's own definition of done lists exactly four
//      operations (claim, look up, list, release) and no fifth. A claim
//      is created with an empty `agentIds` list; populating it is left to
//      whichever future ticket owns that lifecycle, coordinated through
//      the story rather than decided here.
//
// The wire format (parse/serialize below) is combined with the model in
// one file, mirroring the shape `brooswit-factory/candlestix`'s
// `src/registry.ts` uses for its own registry (verified at candlestix's
// own commit) — a versioned envelope, a pure `parse` that never throws
// and reports a shaped error instead, and a `serialize` that is `parse`'s
// exact inverse.
//
// BAKR-16 R-D: `agentIds` is RETIRED from this in-memory model. Membership
// is now a derived query over the agent store (`agentsInDirectory` in
// agent-model.ts — "the agents whose `directory` equals this key"), never a
// second stored copy that could silently disagree with the agent store's
// own `directory` field (B9). The WIRE format below still round-trips an
// `agentIds` field for exactly one reason — see the wire format section —
// but the in-memory `Claim` type here no longer carries it at all.

import type { ClaimKey } from "./claim-key-resolve";

/**
 * `{ dev, ino }` from a real `stat()` of the directory at claim time
 * (BAKR-24 Q2) — recorded OUTSIDE the tree, in this store, never written
 * into the claimed directory itself. Used only to RANK an adoption offer
 * (a same-filesystem `mv` preserves the inode; a cross-filesystem move or a
 * copy does not, and inode numbers are reused after deletion) — never to
 * decide one. See orphan-model.ts for the hint-matching logic this field
 * feeds. Optional because a claim written before this field existed, or one
 * whose caller could not `stat` the directory, has none — see Q1's
 * "reduced confidence" rule for what that absence means downstream.
 */
export interface DirIdentity {
  readonly dev: number;
  readonly ino: number;
}

export interface Claim {
  readonly key: ClaimKey;
  readonly claimedAt: number;
  readonly dirIdentity: DirIdentity | undefined;
}

export interface ClaimStoreState {
  readonly claims: { readonly [key: string]: Claim };
}

export function emptyStore(): ClaimStoreState {
  return { claims: {} };
}

export interface ClaimOutcome {
  readonly state: ClaimStoreState;
  readonly claim: Claim;
}

/**
 * Total and idempotent. If `key` is already claimed, returns `state`
 * unchanged and the EXISTING claim — same `claimedAt`, same `dirIdentity` —
 * never an error, never a re-stamp, and `dirIdentity` is NOT updated on a
 * second claim (identity is a fact about the moment a directory was FIRST
 * claimed). Otherwise creates a new claim with `claimedAt: now` and the
 * given `dirIdentity` (undefined when the caller could not `stat` it, or
 * chose not to).
 */
export function claim(state: ClaimStoreState, key: ClaimKey, now: number, dirIdentity?: DirIdentity): ClaimOutcome {
  const existing = state.claims[key];
  if (existing !== undefined) {
    return { state, claim: existing };
  }
  const created: Claim = { key, claimedAt: now, dirIdentity };
  return {
    state: { claims: { ...state.claims, [key]: created } },
    claim: created,
  };
}

export function lookup(state: ClaimStoreState, key: ClaimKey): Claim | undefined {
  return state.claims[key];
}

export function list(state: ClaimStoreState): readonly Claim[] {
  return Object.values(state.claims);
}

/** Total and idempotent: releasing a `key` with no claim returns `state` unchanged rather than erroring. */
export function release(state: ClaimStoreState, key: ClaimKey): ClaimStoreState {
  if (state.claims[key] === undefined) {
    return state;
  }
  const claims = { ...state.claims };
  delete claims[key];
  return { claims };
}

// --- Wire format -----------------------------------------------------

export const CLAIM_STORE_VERSION = 1;

/**
 * `agentIds` stays in the WIRE format even though `Claim` above no longer
 * carries it (BAKR-16 R-D) — for compatibility in BOTH directions with a
 * binary that predates this change:
 * - `parseClaimStoreState` keeps ACCEPTING the field on read (and now also
 *   accepts a claim entry that lacks it entirely, defaulting to "absent" —
 *   the same "a field whose absence has an obvious correct reading must not
 *   trip the malformed path" lesson session-slots.ts's own parser already
 *   applies to `restoreAttemptCounts`).
 * - `serializeClaimStoreState` keeps WRITING `agentIds: []` on every claim,
 *   a frozen compatibility field, so an OLDER binary reading a file this
 *   version wrote still parses it (that older parser requires the field
 *   and rejects an entry without it as malformed).
 * This is deliberately the one field in this codebase that reads as
 * meaningful but is never populated by anything — labelled as such here so
 * a future reader does not mistake it for a second source of truth. See
 * agent-model.ts's `agentsInDirectory` for where membership actually lives
 * now.
 *
 * `dev`/`ino` (BAKR-24 Q2) are a NEW optional pair carrying `DirIdentity`.
 * Forward compat with a binary that predates them is automatic and requires
 * no frozen placeholder the way `agentIds` needed one: the CURRENT parser
 * (verified at this ticket's own checkout) IGNORES unknown keys entirely
 * (see `isValidPersistedClaim` below — it checks only the keys it knows
 * about), so a binary older than this field simply never sees it. What
 * needs doing on THIS side, per this ticket's own compatibility note, is
 * the other direction: add the field to the persisted type AND the
 * serializer TOGETHER (done below) so a store this version writes is not
 * silently stripped of the identity it just recorded, and extend the
 * round-trip test so serialize stays parse's exact inverse.
 */
interface PersistedClaim {
  readonly claimedAt: number;
  readonly agentIds: readonly string[];
  readonly dev?: number;
  readonly ino?: number;
}

interface PersistedStore {
  readonly version: typeof CLAIM_STORE_VERSION;
  readonly claims: { readonly [key: string]: PersistedClaim };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidPersistedClaim(value: unknown): value is { claimedAt: number; agentIds?: readonly string[]; dev?: number; ino?: number } {
  if (!isPlainObject(value) || typeof value["claimedAt"] !== "number") return false;
  const agentIds = value["agentIds"];
  if (agentIds !== undefined && !(Array.isArray(agentIds) && agentIds.every((id) => typeof id === "string"))) return false;
  const dev = value["dev"];
  const ino = value["ino"];
  // Both present-and-numeric or both absent — a lone dev or ino is a malformed identity, not a partial one.
  if (dev === undefined && ino === undefined) return true;
  return typeof dev === "number" && typeof ino === "number";
}

export function serializeClaimStoreState(state: ClaimStoreState): string {
  const claims: Record<string, PersistedClaim> = {};
  for (const [key, c] of Object.entries(state.claims)) {
    claims[key] = c.dirIdentity === undefined ? { claimedAt: c.claimedAt, agentIds: [] } : { claimedAt: c.claimedAt, agentIds: [], dev: c.dirIdentity.dev, ino: c.dirIdentity.ino };
  }
  const persisted: PersistedStore = { version: CLAIM_STORE_VERSION, claims };
  return JSON.stringify(persisted, null, 2);
}

export type ParseResult = { readonly ok: true; readonly state: ClaimStoreState } | { readonly ok: false; readonly error: string };

/**
 * Pure parse: text in, typed result out, never throws. A malformed or
 * foreign-shaped store is reported as an error, never silently coerced to
 * empty — collapsing that here would make every claimed directory look
 * unclaimed to the caller, which is claim-store-io.ts's job to keep
 * distinct from a genuinely missing file (see that module).
 */
export function parseClaimStoreState(source: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (err) {
    return { ok: false, error: `claim store is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!isPlainObject(parsed) || parsed["version"] !== CLAIM_STORE_VERSION || !isPlainObject(parsed["claims"])) {
    return { ok: false, error: "claim store does not have the expected { version: 1, claims: {...} } shape" };
  }

  const claims: Record<string, Claim> = {};
  for (const [key, value] of Object.entries(parsed["claims"])) {
    if (!isValidPersistedClaim(value)) {
      return {
        ok: false,
        error: `claim entry "${key}" does not have the expected { claimedAt: number, agentIds?: string[] } shape`,
      };
    }
    claims[key] = {
      key: key as ClaimKey,
      claimedAt: value.claimedAt,
      dirIdentity: value.dev !== undefined && value.ino !== undefined ? { dev: value.dev, ino: value.ino } : undefined,
    };
  }
  return { ok: true, state: { claims } };
}
