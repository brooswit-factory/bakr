// The impure adopt orchestrator (BAKR-24 Q3/Q6): the ONLY place that wires
// real stores, a real clock, and real filesystem probing around
// adopt-model.ts's pure `decideAdopt`. In its own module, per this ticket's
// own instruction (a parallel story may be editing agent-model.ts /
// daemon.ts for the create/on/off/... action set).
//
// B10: adoption is ALWAYS OFFERED, NEVER AUTOMATIC — this file is the one
// explicit act. It takes the destination as a raw path (resolved here,
// exactly like the destination a human operator would type) and the
// source/agent ids as already-known identifiers (what a detection offer,
// see orphan-model.ts, hands an operator) — never resolves or selects an
// agent by directory alone (the project-wide rule every file in this tree
// repeats).

import { type ClaimKey } from "./claim-key-resolve";
import { resolveClaimKey, type ResolveInputs } from "./claim-key-resolve";
import { lexicallyNormalize, type LexicalInputs } from "./claim-key";
import { claim, lookup } from "./claim-model";
import { load as loadClaims, withClaimStoreLock } from "./claim-store-io";
import { load as loadAgents, withAgentStoreLock } from "./agent-store-io";
import { classifyDirectory } from "./orphan-model";
import { probeDirectory, type OrphanProbeDeps } from "./orphan-probe";
import { type AdoptInputs, type AdoptRefusal, type ApplyAdoptResult, type ClearedLaunchRecord, validateAdopt, decideAdopt } from "./adopt-model";
import { emptyAgentStore } from "./agent-model";

export interface AdoptDeps {
  readonly claimsPath: string;
  readonly agentsPath: string;
  readonly now: () => number;
  readonly resolveInputs: ResolveInputs;
  readonly lexicalInputs: LexicalInputs;
  readonly probeDeps: OrphanProbeDeps;
  readonly acquireTimeoutMs?: number;
}

export interface AdoptParams {
  readonly source: ClaimKey;
  /** A raw path, exactly as an operator would type it — resolved to a `ClaimKey` here, the same way a destination is resolved everywhere else in this tree (never assumed pre-resolved). */
  readonly destinationInput: string;
  readonly agentIds: readonly string[];
}

export interface AdoptSuccess {
  readonly ok: true;
  readonly destination: ClaimKey;
  readonly adoptedAgentIds: readonly string[];
  /** B13: every launch record adoption discarded, reported so the clearing is never silent. */
  readonly clearedLaunchRecords: readonly ClearedLaunchRecord[];
}

/** A superset of adopt-model.ts's own `AdoptRefusal` (B11's domain refusal set) with the two impure, store-degradation outcomes that can only be discovered here — a malformed store is reported exactly like every other loader in this tree reports it, never silently coerced to empty (B12). */
export type AdoptOutcome = AdoptSuccess | AdoptRefusal | { readonly ok: false; readonly reason: "store-degraded"; readonly message: string };

function lockOpts(deps: AdoptDeps): { acquireTimeoutMs?: number } {
  const opts: { acquireTimeoutMs?: number } = {};
  if (deps.acquireTimeoutMs !== undefined) opts.acquireTimeoutMs = deps.acquireTimeoutMs;
  return opts;
}

/**
 * The one act (Q3). Order of operations, and why it is exactly this order:
 *
 * 1. Cheap, storeless checks first (empty selection, destination path
 *    resolves to an existing DIRECTORY, destination != source) — no point
 *    claiming anything or touching the agent store for a request that is
 *    malformed on its face.
 * 2. Classify the SOURCE directory (a real `stat`, via orphan-model.ts's
 *    `classifyDirectory` — the identical function daemon.ts's own Q4 report
 *    path uses) and refuse `source-not-orphaned`/`source-unavailable`
 *    before doing anything else.
 * 3. A PRELIMINARY, UNLOCKED read of the agent store, validated with the
 *    exact same `validateAdopt` the real mutation uses — this is what
 *    keeps an outright-invalid request (unknown id, wrong source, a real
 *    name collision) from claiming the destination at all. This read is
 *    NEVER trusted for the actual mutation (R-F.3's own discipline,
 *    mirrored from daemon.ts) — it exists only to avoid a needless claim.
 * 4. Claim the destination (Q6) — idempotent, so a crash right after this
 *    step leaves a harmless claimed-but-empty directory; re-running adopt
 *    completes the job. Claiming BEFORE moving agents (never the reverse)
 *    matters because the reconcile loop iterates CLAIMS: an agent moved
 *    into an unclaimed directory would never be visited again — a far
 *    worse failure than a stray empty claim.
 * 5. `withAgentStoreLock`: re-read the agent store FRESH, re-validate EVERY
 *    refusal against that fresh read (this is the check the Q3 concurrent-
 *    adopt race actually depends on — a second adopter's re-validation
 *    here is what produces its typed, current-directory-naming refusal),
 *    and move all named agents' `directory` to the destination in exactly
 *    ONE state transition persisted by exactly one write.
 */
export async function adopt(deps: AdoptDeps, params: AdoptParams): Promise<AdoptOutcome> {
  if (params.agentIds.length === 0) {
    return { ok: false, reason: "empty-selection", message: "no agents were named — adopt requires an explicit list of agent ids naming exactly which agents to move (B10)" };
  }

  const lexical = lexicallyNormalize(params.destinationInput, deps.lexicalInputs);
  const resolved = await resolveClaimKey(lexical, deps.resolveInputs);
  if (!resolved.ok) {
    return {
      ok: false,
      reason: "destination-missing",
      message: resolved.reason === "does-not-exist" ? `the destination "${params.destinationInput}" does not exist — bakr never creates a destination directory` : `the destination "${params.destinationInput}" could not be resolved: ${resolved.message}`,
    };
  }
  const destination = resolved.key;

  if (destination === params.source) {
    return { ok: false, reason: "destination-is-source", message: `the destination "${destination}" is the same directory as the source — there is nothing to adopt` };
  }

  const destinationProbe = await probeDirectory(destination, deps.probeDeps);
  if (destinationProbe.kind !== "exists") {
    return { ok: false, reason: "destination-missing", message: `the destination "${destination}" does not exist — bakr never creates a destination directory` };
  }
  if (!destinationProbe.isDirectory) {
    return { ok: false, reason: "destination-not-a-directory", message: `the destination "${destination}" exists but is not a directory` };
  }

  const sourceProbe = await probeDirectory(params.source, deps.probeDeps);
  // Read-only peek at the claim store for the source's recorded identity
  // (Q2) — never through the lock, exactly like daemon.ts's own read-only
  // use of the claim store (nothing here mutates claims.json; the ONLY
  // claim-store write in this whole file is the destination-claim step
  // below, which does go through `withClaimStoreLock`).
  const claimsPeek = await loadClaims(deps.claimsPath);
  if (claimsPeek.status === "malformed") {
    return { ok: false, reason: "store-degraded", message: `the claim store at "${deps.claimsPath}" is malformed: ${claimsPeek.error} — refusing to adopt` };
  }
  const sourceDirIdentity = claimsPeek.status === "loaded" ? lookup(claimsPeek.state, params.source)?.dirIdentity : undefined;
  const sourceVerdict = classifyDirectory(sourceProbe, sourceDirIdentity?.dev);
  if (sourceVerdict.status !== "gone") {
    if (sourceVerdict.status === "present") {
      return { ok: false, reason: "source-not-orphaned", message: `the source directory "${params.source}" still resolves — adopt is defined on orphaned (gone) directories only` };
    }
    return { ok: false, reason: "source-unavailable", message: `the source directory "${params.source}": ${sourceVerdict.reason}` };
  }

  // A PRELIMINARY, UNLOCKED peek at the agent store — mirrors daemon.ts's
  // own outer, unlocked read (R-F.3): used only to avoid claiming the
  // destination for a request that is already invalid on its face; NEVER
  // trusted for the actual mutation, which re-reads fresh inside the lock
  // below regardless.
  const agentsPeek = await loadAgents(deps.agentsPath);
  if (agentsPeek.status === "malformed") {
    return { ok: false, reason: "store-degraded", message: `the agent store at "${deps.agentsPath}" is malformed: ${agentsPeek.error} — refusing to adopt` };
  }
  const preliminaryInputs: AdoptInputs = {
    agentState: agentsPeek.status === "loaded" ? agentsPeek.state : emptyAgentStore(),
    source: params.source,
    destination,
    agentIds: params.agentIds,
    sourceVerdictStatus: "gone",
  };
  const preliminaryValidation = validateAdopt(preliminaryInputs);
  if (!preliminaryValidation.ok) {
    return preliminaryValidation;
  }

  // Q6: claim the destination FIRST — idempotent, so a crash between this
  // and the agent-store write below leaves a harmless claimed-but-empty
  // directory rather than agents whose directory the reconcile loop's own
  // claim-iteration would never visit again.
  const destIdentity = { dev: destinationProbe.device, ino: destinationProbe.inode };
  const claimResult = await withClaimStoreLock(
    deps.claimsPath,
    (current) => {
      const outcome = claim(current, destination, deps.now(), destIdentity);
      return { state: outcome.state, result: outcome.claim };
    },
    lockOpts(deps)
  );
  if (claimResult.status === "malformed") {
    return { ok: false, reason: "store-degraded", message: `the claim store at "${deps.claimsPath}" is malformed: ${claimResult.error} — refusing to adopt` };
  }

  const mutation = await withAgentStoreLock<AdoptRefusal | ApplyAdoptResult>(
    deps.agentsPath,
    (current) => {
      const inputs: AdoptInputs = { agentState: current, source: params.source, destination, agentIds: params.agentIds, sourceVerdictStatus: "gone" };
      const decision = decideAdopt(inputs);
      if (!decision.ok) {
        return { state: current, result: decision };
      }
      return { state: decision.state, result: decision };
    },
    lockOpts(deps)
  );
  if (mutation.status === "malformed") {
    return { ok: false, reason: "store-degraded", message: `the agent store at "${deps.agentsPath}" is malformed: ${mutation.error} — refusing to adopt (the destination claim above, if newly created, is left in place — harmless, re-running adopt completes the job)` };
  }

  const decision = mutation.result;
  if (!decision.ok) {
    return decision;
  }
  return { ok: true, destination: decision.destination, adoptedAgentIds: decision.adoptedAgentIds, clearedLaunchRecords: decision.clearedLaunchRecords };
}
