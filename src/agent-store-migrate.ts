// The session-slots.json -> agents.json migration (BAKR-16 R-A, R-C). The
// highest-risk piece of this story: session-slots.json on a real operator's
// disk holds sessions the daemon is actively restoring, so dropping any of
// them silently breaks restore for directories that are already claimed
// (explicitly NOT the "silently migrating an operator-written file" hazard
// from elsewhere in this estate; these are records bakr itself wrote
// because an operator turned those agents on).
//
// The rule this file exists to implement, verbatim from the ticket (R-A.1):
//
//   agents.json is authoritative whenever it exists. session-slots.json is
//   read only when agents.json is absent. A malformed agents.json is NOT
//   an absent one — it must never fall back to session-slots.json.
//
// That rule is what makes migration idempotent under a crash at ANY point:
// the migration writes agents.json atomically (via agent-store-io.ts's own
// atomic `save`, and — for the race-safety half — through
// `withAgentStoreLock`), so either it landed (migration done, the old file
// is never read again) or it did not (the old file is untouched, migrate
// again next time). `session-slots.json` itself is NEVER deleted or
// renamed by this file — it stays exactly as it is, a recoverable
// breadcrumb.
//
// Split into a PURE half (`migrateSessionSlots` — session-slots state in,
// agent-store state out, `now`/`randomBytes` as its only impure inputs, both
// injected) and an impure orchestrator (`loadOrMigrateAgentStore` — the one
// real caller, wired from index.ts/daemon.ts) exactly mirroring this
// codebase's existing pure/impure seams (xdg.ts/paths.ts,
// claim-key.ts/claim-key-resolve.ts).

import type { ClaimKey } from "./claim-key-resolve";
import { emptySessionSlots, type SessionSlotsState } from "./session-slots";
import { load as loadSlotsFile } from "./session-slots-store";
import { type AgentRecord, type AgentStoreState, type LaunchRecord, type PendingCreationRecord, emptyAgentStore, mintUniqueAgentId, putAgent } from "./agent-model";
import { load as loadAgentsFile, withAgentStoreLock } from "./agent-store-io";

export interface MigrationSummary {
  readonly agentsCreated: number;
  readonly directories: readonly ClaimKey[];
  /**
   * R-C.3 case 3: a v1 launch record whose `launchShortId` was already set
   * (launch() genuinely succeeded) but with no `priorSessionId` — a fresh
   * registration in flight, with no slot and so no agent to attach to yet.
   * Carried forward as a `PendingCreationRecord`, NOT dropped and NOT
   * marked unresolved — see `migrateSessionSlots`'s own doc.
   */
  readonly pendingCreationsCarriedForward: number;
  /**
   * R-C.3 case 1/2, and the defensive fallback: a v1 launch record whose
   * `priorSessionId` is defined but matches no migrated agent's
   * `durableSessionId` (believed unreachable in practice), OR a record
   * with no `priorSessionId` that is NOT case 3 (i.e. it already has an
   * `error`, or it is itself wedged with no shortId and no error — see
   * below). There is nothing to attach it to, and attaching it by
   * directory is the one thing this product forbids (B2). Dropped from
   * the new store's `launches` — never silently, always counted here so
   * the migration's own loud log line reports it to a human.
   */
  readonly unattachedLaunchesDropped: number;
  /**
   * R-C.1: `restoreAttemptCounts` entries that could not be translated
   * through the `durableSessionId -> agentId` correspondence (old
   * directory-keyed leftovers predating BAKR-13, or any other key matching
   * no migrated slot) — dropped rather than carried forward under a key
   * that will never again match anything, per the story's explicit
   * allowance ("may be dropped; say so").
   */
  readonly danglingRetryCountsDropped: number;
}

export interface MigrationResult {
  readonly state: AgentStoreState;
  readonly summary: MigrationSummary;
}

/**
 * Pure: `slots` (an already-parsed `SessionSlotsState` — the caller is
 * responsible for handling `missing`/`malformed` before calling this, see
 * `loadOrMigrateAgentStore`) in, a fresh `AgentStoreState` out. `now` and
 * `randomBytes` are the only impure inputs, both injected.
 *
 * Each v1 slot (`session-slots.ts`'s parser already normalizes all three
 * shapes the ticket names — current v1, legacy bare-string entries, and v1
 * missing `restoreAttemptCounts` — into one uniform `SessionSlotsState`
 * before this function ever sees it, so this function itself needs no
 * shape-specific logic) becomes exactly ONE unnamed `on` agent, with a
 * freshly minted id, its two session ids preserved BYTE-FOR-BYTE, and
 * `directory` set to the claim key the slot was filed under.
 *
 * `restoreAttemptCounts` (R-C.1) is TRANSLATED through the
 * `durableSessionId -> agentId` correspondence built above, not carried
 * forward under its old key — an entry matching no migrated slot is
 * dropped (`danglingRetryCountsDropped`), the story's own explicit
 * allowance, rather than kept as a key that can never again match
 * anything.
 *
 * `launches` (R-C.2, R-C.3 — AMENDED, R-C.3 reverses an earlier version of
 * this rule that treated every launch record the same) is split by the
 * v1 record's OWN state into three cases, because they are not
 * equivalent:
 *
 * 1. **No `launchShortId`, no `error`** (wedged — `launch()` never
 *    returned before the old binary stopped). If its `priorSessionId`
 *    matches a migrated slot, it is carried forward attached to that
 *    agent, UNCHANGED — the daemon's own `promoteWedgedLaunches` (run at
 *    the top of every reconcile cycle, including the first one after
 *    migration) already promotes exactly this shape to permanently
 *    unresolved; nothing migration-specific is needed here. If it has no
 *    matching slot (most commonly: `priorSessionId` was never set — a
 *    fresh registration that crashed before even getting a short id),
 *    there is nothing to ever attach it to (no short id to match a future
 *    listing against either) — dropped, counted in
 *    `unattachedLaunchesDropped`.
 * 2. **`error` set** (permanently unresolved, already given up on). R-C.2
 *    is the load-bearing case: `hasLaunchRecordFor` is keyed by agent id,
 *    so if migration fails to attach this record to the agent its
 *    `priorSessionId` belongs to, the guarantee "never retried
 *    automatically" (Constraint 2) evaporates and the daemon relaunches a
 *    session it had already given up on, once, silently, on upgrade. Kept
 *    attached whenever `priorSessionId` matches a migrated slot; dropped
 *    (counted) only in the defensive case of no match.
 * 3. **`launchShortId` set, `error` NOT set** (genuinely pending — the old
 *    binary's `launch()` succeeded and it was only waiting for a listing to
 *    reveal the resolved session id). If `priorSessionId` is defined, this
 *    is an ordinary pending RESTORE and is attached to its matching agent
 *    exactly like case 2. If `priorSessionId` is undefined, this is a
 *    pending FRESH registration with no slot and so no existing agent —
 *    marking it unresolved here would orphan a live session the operator
 *    deliberately started, and matching it to any existing agent would be
 *    exactly the directory-derived fabrication B2 forbids. Instead it is
 *    carried forward as a `PendingCreationRecord` (`pendingCreationsCarriedForward`):
 *    a NEW, unnamed `on` agent is minted only once a future listing
 *    resolves its short id (see `resolvePendingCreation` in
 *    agent-model.ts), in the directory this record itself names as its
 *    launch target — never a listing entry's own `cwd`.
 */
export function migrateSessionSlots(slots: SessionSlotsState, deps: { readonly now: () => number; readonly randomBytes: (byteLength: number) => Uint8Array }): MigrationResult {
  let state = emptyAgentStore();
  const directories = new Set<ClaimKey>();
  let agentsCreated = 0;
  const agentIdByDurableSessionId = new Map<string, string>();

  for (const [rawKey, slotList] of Object.entries(slots.onByKey)) {
    const key = rawKey as ClaimKey;
    directories.add(key);
    for (const slot of slotList) {
      const id = mintUniqueAgentId(state, deps.randomBytes);
      const agent: AgentRecord = {
        id,
        name: undefined,
        directory: key,
        state: "on",
        createdAt: deps.now(),
        birthSessionId: slot.durableSessionId,
        restoreTarget: { sessionId: slot.liveSessionId, shortId: slot.liveSessionId.slice(0, 8) },
      };
      state = putAgent(state, agent);
      agentsCreated += 1;
      agentIdByDurableSessionId.set(slot.durableSessionId, id);
    }
  }

  // R-C.1: translate restoreAttemptCounts through the same correspondence.
  const restoreAttemptCounts: Record<string, number> = {};
  let danglingRetryCountsDropped = 0;
  for (const [durableSessionId, count] of Object.entries(slots.restoreAttemptCounts)) {
    const agentId = agentIdByDurableSessionId.get(durableSessionId);
    if (agentId === undefined) {
      danglingRetryCountsDropped += 1;
      continue;
    }
    restoreAttemptCounts[agentId] = count;
  }

  // R-C.2 / R-C.3: split each v1 launch record by its own state.
  let unattachedLaunchesDropped = 0;
  let pendingCreationsCarriedForward = 0;
  const launches: LaunchRecord[] = [];
  const pendingCreations: PendingCreationRecord[] = [];

  for (const record of slots.launches) {
    const isPendingWithNoPriorSession = record.launchShortId !== undefined && record.error === undefined && record.priorSessionId === undefined;

    if (isPendingWithNoPriorSession) {
      // Case 3, fresh: carry forward as a pending creation — never mark unresolved, never attach to an existing agent.
      pendingCreations.push({ attemptId: record.attemptId, key: record.key, launchShortId: record.launchShortId as string, attemptedAt: record.attemptedAt });
      pendingCreationsCarriedForward += 1;
      directories.add(record.key);
      continue;
    }

    // Cases 1 (wedged), 2 (errored), and 3-restore (pending with a priorSessionId): attach via the durableSessionId correspondence, or drop+report if unattachable.
    const agentId = record.priorSessionId !== undefined ? agentIdByDurableSessionId.get(record.priorSessionId) : undefined;
    if (agentId === undefined) {
      unattachedLaunchesDropped += 1;
      continue;
    }
    launches.push({
      attemptId: record.attemptId,
      agentId,
      key: record.key,
      attemptKey: record.priorSessionId === undefined ? undefined : { kind: "respawn", shortId: record.priorSessionId.slice(0, 8) },
      attemptedAt: record.attemptedAt,
      launchShortId: record.launchShortId,
      error: record.error,
    });
  }

  state = { ...state, launches, restoreAttemptCounts, pendingCreations };

  return { state, summary: { agentsCreated, directories: [...directories], pendingCreationsCarriedForward, unattachedLaunchesDropped, danglingRetryCountsDropped } };
}

export interface LoadOrMigrateDeps {
  readonly agentsPath: string;
  readonly sessionSlotsPath: string;
  readonly now: () => number;
  readonly randomBytes: (byteLength: number) => Uint8Array;
}

export type LoadOrMigrateOutcome =
  | { readonly status: "loaded"; readonly state: AgentStoreState }
  | { readonly status: "migrated"; readonly state: AgentStoreState; readonly summary: MigrationSummary }
  | { readonly status: "malformed"; readonly error: string; readonly source: "agents" | "session-slots" };

/**
 * The one real orchestrator: implements "agents.json is authoritative
 * whenever it exists; session-slots.json is read only when agents.json is
 * absent, and a MALFORMED agents.json is never treated as absent" (R-A.1)
 * end to end, including the race-safety half — the actual migration WRITE
 * goes through `withAgentStoreLock` (R-F: "every mutation of agents.json
 * ... goes through one helper"), so two processes racing to migrate at the
 * same time cannot each mint a disjoint set of agents and have one
 * silently clobber the other's write; the second to reach the lock finds
 * agents already present and migrates nothing.
 *
 * Migration is persisted at most ONCE across the life of the store: a later
 * call (this process or a fresh one) that finds `agents.json` already
 * present short-circuits at the very first read and never touches
 * `session-slots.json` at all, let alone mints anything (AC1 tests this
 * with two separate process runs and asserts identical agent ids).
 */
export async function loadOrMigrateAgentStore(deps: LoadOrMigrateDeps): Promise<LoadOrMigrateOutcome> {
  const peeked = await loadAgentsFile(deps.agentsPath);
  if (peeked.status === "malformed") {
    return { status: "malformed", error: peeked.error, source: "agents" };
  }
  if (peeked.status === "loaded") {
    return { status: "loaded", state: peeked.state };
  }

  // agents.json is absent — and ONLY now do we read session-slots.json (R-A.1).
  const slotsLoaded = await loadSlotsFile(deps.sessionSlotsPath);
  if (slotsLoaded.status === "malformed") {
    return { status: "malformed", error: slotsLoaded.error, source: "session-slots" };
  }
  const slotsState = slotsLoaded.status === "loaded" ? slotsLoaded.state : emptySessionSlots();

  interface LockMutateResult {
    readonly state: AgentStoreState;
    readonly summary: MigrationSummary | undefined;
  }

  const lockResult = await withAgentStoreLock<LockMutateResult>(deps.agentsPath, (current) => {
    if (Object.keys(current.agents).length > 0) {
      // Another process (or an earlier call in this one) already migrated
      // between our unlocked peek above and this lock being granted —
      // migrate nothing, report what is actually on disk now.
      return { state: current, result: { state: current, summary: undefined } };
    }
    const { state, summary } = migrateSessionSlots(slotsState, { now: deps.now, randomBytes: deps.randomBytes });
    return { state, result: { state, summary } };
  });

  if (lockResult.status === "malformed") {
    return { status: "malformed", error: lockResult.error, source: "agents" };
  }
  if (lockResult.result.summary === undefined) {
    return { status: "loaded", state: lockResult.result.state };
  }
  return { status: "migrated", state: lockResult.result.state, summary: lockResult.result.summary };
}
