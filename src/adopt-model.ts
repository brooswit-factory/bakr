// The pure adopt core (BAKR-24 Q3/Q5/Q6/Q7): the refusal set (B11 — typed,
// message shown verbatim) and the single state transition a permitted
// adopt applies. Plain functions over plain data, exactly like
// claim-model.ts / agent-model.ts — no filesystem, no store I/O, no lock
// here at all. adopt.ts (the impure orchestrator) is the only caller,
// wiring in real stores/probes and calling `decideAdopt` from inside a
// single `withAgentStoreLock` hold (see that file).
//
// agent-model.ts deliberately ships no "adopt" verb of its own (see its own
// module comment) — this file is that verb's validated core, built on the
// low-level primitives agent-model.ts DOES ship: `setAgentDirectory`,
// `discardLaunchRecordsForAgents`, `resetRestoreAttempts`,
// `checkNameAvailability`, `lookupAgentById`.

import type { ClaimKey } from "./claim-key-resolve";
import { type AgentRecord, type AgentStoreState, checkNameAvailability, discardLaunchRecordsForAgents, lookupAgentById, resetRestoreAttempts, setAgentDirectory } from "./agent-model";

// --- The refusal set (B11) ---------------------------------------------

/**
 * `agents-already-adopted` (named in the ticket's own refusal list, "named
 * agents no longer live in the source") and `agent-not-in-source` ("a real
 * agent that does not live in the source directory") describe two
 * SCENARIOS an operator can land in, but at adopt-validation time they are
 * the identical check: is `agent.directory === source` right now? `adopt`
 * takes no held reference to an earlier offer (B10 — just an explicit
 * source, destination, and agent ids), so there is no data available here
 * to distinguish "this id was never in `source`" from "it WAS, until a
 * concurrent adopt just moved it" — both are "not in source, right now".
 * Rather than fabricate a distinction the code cannot actually make,
 * this ships ONE typed reason, `"agent-not-in-source"`, covering both; its
 * message names the agent's CURRENT directory, which is exactly the
 * information the ticket's own "second adopter" scenario asks the refusal
 * to carry ("naming where the agents went"). See
 * test/unit/adopt-model.test.ts for both scenarios exercised against this
 * one reason — a caller-error id that was never in source, and a genuine
 * concurrent-adopt race — and the PR description for this same argument.
 */
export type AdoptRefusal =
  | { readonly ok: false; readonly reason: "empty-selection"; readonly message: string }
  | { readonly ok: false; readonly reason: "destination-is-source"; readonly message: string }
  | { readonly ok: false; readonly reason: "source-not-orphaned"; readonly message: string }
  | { readonly ok: false; readonly reason: "source-unavailable"; readonly message: string }
  | { readonly ok: false; readonly reason: "destination-missing"; readonly message: string }
  | { readonly ok: false; readonly reason: "destination-not-a-directory"; readonly message: string }
  | { readonly ok: false; readonly reason: "unknown-agent"; readonly message: string; readonly agentIds: readonly string[] }
  | { readonly ok: false; readonly reason: "agent-not-in-source"; readonly message: string; readonly agents: readonly { readonly id: string; readonly currentDirectory: ClaimKey }[] }
  | { readonly ok: false; readonly reason: "name-collision"; readonly message: string; readonly conflicts: readonly { readonly agentId: string; readonly name: string; readonly heldBy: string }[] };

/** One entry per launch record adoption discarded (B13/Q5) — reported so the clearing is never silent (B13's own requirement). `error` is `undefined` when the record was still pending (no outcome recorded yet) rather than given up on. */
export interface ClearedLaunchRecord {
  readonly agentId: string;
  readonly attemptId: string;
  readonly error: string | undefined;
}

export interface AdoptInputs {
  readonly agentState: AgentStoreState;
  readonly source: ClaimKey;
  readonly destination: ClaimKey;
  readonly agentIds: readonly string[];
  /**
   * The SOURCE directory's orphan-model.ts verdict status, classified by
   * the caller (a real `stat`) just before this validation runs — the same
   * "fetch once outside, validate the freshly-read STORE state inside"
   * shape daemon.ts's own `decideAndBeginForAgent` already uses for
   * `sessions` (see that file's module comment on R-F.3): the per-agent
   * STORE check below (`agent.directory === source`) is what is re-derived
   * fresh on every call against a freshly re-read `agentState` — that is
   * the check the Q3 concurrent-adopt race actually depends on. This
   * status is a single point-in-time filesystem read, not itself re-taken
   * inside the lock.
   */
  readonly sourceVerdictStatus: "present" | "gone" | "unavailable";
}

export type AdoptValidation = { readonly ok: true } | AdoptRefusal;

/**
 * Every refusal in the set, re-derivable from nothing but `inputs` — call
 * this against a FRESH `agentState` read (see adopt.ts) so the checks that
 * matter under concurrency (`unknown-agent`, `agent-not-in-source`,
 * `name-collision`) are re-validated against the current store, not a
 * stale snapshot (B12/Q3).
 */
export function validateAdopt(inputs: AdoptInputs): AdoptValidation {
  const { agentState, source, destination, agentIds, sourceVerdictStatus } = inputs;

  if (agentIds.length === 0) {
    return { ok: false, reason: "empty-selection", message: "no agents were named — adopt requires an explicit list of agent ids naming exactly which agents to move (B10)" };
  }
  if (destination === source) {
    return { ok: false, reason: "destination-is-source", message: `the destination "${destination}" is the same directory as the source — there is nothing to adopt` };
  }
  if (sourceVerdictStatus === "present") {
    return { ok: false, reason: "source-not-orphaned", message: `the source directory "${source}" still resolves — adopt is defined on orphaned (gone) directories only` };
  }
  if (sourceVerdictStatus === "unavailable") {
    return {
      ok: false,
      reason: "source-unavailable",
      message: `the source directory "${source}" could not be classified as gone (unmounted drive? dead network filesystem? permission error?) — refusing to move agents away from a directory that may still be there`,
    };
  }

  const unknownIds = agentIds.filter((id) => lookupAgentById(agentState, id) === undefined);
  if (unknownIds.length > 0) {
    return { ok: false, reason: "unknown-agent", message: `these agent ids are not in the store at all: ${unknownIds.join(", ")}`, agentIds: unknownIds };
  }

  const notInSource = agentIds
    .map((id) => agentState.agents[id] as AgentRecord)
    .filter((agent) => agent.directory !== source)
    .map((agent) => ({ id: agent.id, currentDirectory: agent.directory }));
  if (notInSource.length > 0) {
    return {
      ok: false,
      reason: "agent-not-in-source",
      message: `these agents do not currently live in "${source}" — either this id was never there, or a concurrent adopt already moved it: ${notInSource.map((a) => `${a.id} (now in "${a.currentDirectory}")`).join(", ")}`,
      agents: notInSource,
    };
  }

  const conflicts: { agentId: string; name: string; heldBy: string }[] = [];
  for (const id of agentIds) {
    const agent = agentState.agents[id] as AgentRecord;
    if (agent.name === undefined) continue;
    // Every named agent currently lives in `source` (just proved above), so
    // it cannot be its own collision target in `destination` — no
    // `excludingAgentId` is needed, unlike a rename's own availability check.
    const availability = checkNameAvailability(agentState, destination, agent.name);
    if (!availability.ok) {
      conflicts.push({ agentId: id, name: agent.name, heldBy: availability.heldBy.id });
    }
  }
  if (conflicts.length > 0) {
    return {
      ok: false,
      reason: "name-collision",
      message: `these names are already held in the destination "${destination}" (archived agents keep their names — B4): ${conflicts.map((c) => `"${c.name}" (wanted by ${c.agentId}, held by ${c.heldBy})`).join(", ")}`,
      conflicts,
    };
  }

  return { ok: true };
}

export interface ApplyAdoptResult {
  readonly ok: true;
  readonly state: AgentStoreState;
  readonly destination: ClaimKey;
  readonly adoptedAgentIds: readonly string[];
  readonly clearedLaunchRecords: readonly ClearedLaunchRecord[];
}

/**
 * Applies the single state transition B10/Q3 asks for — ALL named agents'
 * `directory` moved to `destination`, retry counts reset, and (B13/Q5,
 * corrected) EVERY launch record belonging to any named agent discarded,
 * not only the ones the move itself would explain. See this file's module
 * comment and agent-model.ts's own `discardLaunchRecordsForAgents` doc for
 * the full reasoning — restated briefly: the only signal available to tell
 * "this give-up's cause no longer applies" from "it still does" is the
 * record's own error string, which has been MEASURED to misattribute its
 * own cause (a missing-cwd launch failure reads as a `systemd-run`
 * problem), so building a correctness-critical branch on it would be
 * exactly the mistake this story exists to avoid. B13 makes this a general
 * rule: only an explicit operator action (this one) may clear such a
 * record, the reconcile loop never does, and the clearing must be
 * reported — never silent — hence `clearedLaunchRecords` below.
 *
 * The caller MUST have already gotten `{ ok: true }` from `validateAdopt`
 * against THE SAME `agentState` — this function performs no refusal checks
 * of its own; see `decideAdopt` for the combinator that does both.
 */
export function applyAdopt(agentState: AgentStoreState, destination: ClaimKey, agentIds: readonly string[]): ApplyAdoptResult {
  const clearedLaunchRecords: ClearedLaunchRecord[] = agentState.launches.filter((l) => agentIds.includes(l.agentId)).map((l) => ({ agentId: l.agentId, attemptId: l.attemptId, error: l.error }));

  let next = discardLaunchRecordsForAgents(agentState, agentIds);
  for (const id of agentIds) {
    next = resetRestoreAttempts(next, id);
    next = setAgentDirectory(next, id, destination);
  }

  return { ok: true, state: next, destination, adoptedAgentIds: [...agentIds], clearedLaunchRecords };
}

/** `validateAdopt` then `applyAdopt` in one call — what adopt.ts's locked `mutate` callback uses, so there is exactly one state transition per successful adopt (Q3), persisted by exactly one write. */
export function decideAdopt(inputs: AdoptInputs): AdoptRefusal | ApplyAdoptResult {
  const validation = validateAdopt(inputs);
  if (!validation.ok) return validation;
  return applyAdopt(inputs.agentState, inputs.destination, inputs.agentIds);
}
