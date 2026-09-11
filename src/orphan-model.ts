// The pure orphan-detection core (BAKR-24 Q1/Q2): classification, offer
// construction, and the hint (never-decides) match — plain functions over
// plain data, exactly like claim-model.ts / agent-model.ts. No filesystem
// here at all; `DirectoryProbe` (orphan-probe.ts) is the only impure input,
// already reduced to plain data by the time it reaches this file.
//
// Detection NEVER mutates (Q1): every function below is a pure read over
// its inputs. There is no code path in this file that writes a store,
// releases a claim, rewrites a directory, or launches anything — "offers
// never act" is true by construction here, not by convention (see
// test/unit/orphan-model.test.ts's "byte-identical store" proof, which
// exercises this file plus the real store I/O together).

import type { ClaimKey } from "./claim-key-resolve";
import type { Claim, ClaimStoreState, DirIdentity } from "./claim-model";
import { list as listClaims } from "./claim-model";
import type { AgentLifecycleState, AgentStoreState } from "./agent-model";
import { agentsInDirectory } from "./agent-model";
import type { DirectoryProbe } from "./orphan-probe";

// --- Q1: the three-valued verdict ------------------------------------------

export type OrphanVerdict =
  | { readonly status: "present" }
  | { readonly status: "gone"; readonly confidence: "high" | "reduced"; readonly reason: string }
  | { readonly status: "unavailable"; readonly reason: string };

/**
 * Turns one `DirectoryProbe` (orphan-probe.ts) into a verdict. `recordedDevice`
 * is the `dev` half of the claim's own `DirIdentity` (claim-model.ts),
 * `undefined` for a claim written before Q2 shipped.
 *
 * `gone` requires POSITIVE evidence (Q1's own words) — in doubt, `unavailable`:
 * - No readable ancestor at all -> `unavailable` (cannot even confirm the
 *   path is truly absent rather than merely unreachable).
 * - A readable ancestor on a DIFFERENT device than what was recorded at claim
 *   time -> `unavailable` (very likely an unmounted filesystem, not a real
 *   removal — Q1's own example).
 * - A readable ancestor on the SAME recorded device -> `gone`, `"high"`
 *   confidence.
 * - A readable ancestor but NO device was ever recorded (an old claim) ->
 *   `gone`, `"reduced"` confidence — offered, but the caller must say so
 *   rather than hide it (Q1's explicit instruction).
 */
export function classifyDirectory(probe: DirectoryProbe, recordedDevice: number | undefined): OrphanVerdict {
  if (probe.kind === "exists") {
    return { status: "present" };
  }
  if (probe.kind === "stat-error") {
    return { status: "unavailable", reason: `could not stat the directory: ${probe.message}` };
  }

  const ancestor = probe.ancestor;
  if (ancestor === undefined) {
    return { status: "unavailable", reason: "the directory is missing and no existing ancestor could be found at all — cannot confirm it is truly gone rather than merely unreachable" };
  }
  if (!ancestor.readable) {
    return { status: "unavailable", reason: `the directory is missing and its nearest existing ancestor "${ancestor.path}" could not be stat'd — cannot distinguish "gone" from "temporarily unreachable"` };
  }
  if (recordedDevice === undefined) {
    return {
      status: "gone",
      confidence: "reduced",
      reason: `the directory is missing and its nearest existing ancestor "${ancestor.path}" is readable, but this claim recorded no device id at claim time (an older claim) to corroborate — REDUCED CONFIDENCE`,
    };
  }
  if (ancestor.device !== recordedDevice) {
    return {
      status: "unavailable",
      reason: `the directory is missing; its nearest existing ancestor "${ancestor.path}" is on device ${ancestor.device}, not the device ${recordedDevice} recorded when this directory was claimed — likely an unmounted filesystem, not a genuine removal`,
    };
  }
  return {
    status: "gone",
    confidence: "high",
    reason: `the directory is missing; its nearest existing ancestor "${ancestor.path}" is readable and on the same device (${recordedDevice}) recorded when this directory was claimed`,
  };
}

// --- Classification over a whole claim store --------------------------------

export interface AgentSummary {
  readonly id: string;
  readonly name: string | undefined;
  readonly state: AgentLifecycleState;
}

export interface ClaimClassification {
  readonly claim: Claim;
  readonly verdict: OrphanVerdict;
  readonly agents: readonly AgentSummary[];
}

/**
 * Classifies every claim in `claimState` given a pre-fetched `probes` map
 * (one `DirectoryProbe` per claim key — fetching them is the impure edge,
 * see orphan-probe.ts; this function itself touches no filesystem). A claim
 * with no entry in `probes` classifies as `unavailable` — "we did not even
 * look" is exactly the "cannot tell" case Q1 defines `unavailable` to mean,
 * never silently skipped and never guessed at as `gone`.
 */
export function classifyClaims(claimState: ClaimStoreState, agentState: AgentStoreState, probes: ReadonlyMap<ClaimKey, DirectoryProbe>): readonly ClaimClassification[] {
  return listClaims(claimState).map((c): ClaimClassification => {
    const probe = probes.get(c.key);
    const verdict: OrphanVerdict = probe === undefined ? { status: "unavailable", reason: `no probe result was supplied for "${c.key}" — treated as unavailable, never guessed as gone` } : classifyDirectory(probe, c.dirIdentity?.dev);
    const agents = agentsInDirectory(agentState, c.key).map((a): AgentSummary => ({ id: a.id, name: a.name, state: a.state }));
    return { claim: c, verdict, agents };
  });
}

// --- Q1: only `gone` produces an offer --------------------------------------

export interface AdoptionOffer {
  readonly source: ClaimKey;
  readonly claimedAt: number;
  readonly confidence: "high" | "reduced";
  readonly reason: string;
  readonly agents: readonly AgentSummary[];
  /** Set only after `applyDestinationHint` below finds a match — never populated by `buildOffers` itself. */
  readonly hintMatchedDestination: ClaimKey | undefined;
  /** Carried through so `applyDestinationHint` needs no second lookup against the claim store — internal plumbing, not meant for an operator-facing rendering of the offer. */
  readonly sourceDirIdentity: DirIdentity | undefined;
}

/** Only classifications with verdict `gone` become offers — `present` is excluded because it is not an orphan, `unavailable` is excluded per Q1 ("only `gone` produces an offer; `unavailable` produces a report and nothing else"). */
export function buildOffers(classifications: readonly ClaimClassification[]): readonly AdoptionOffer[] {
  const offers: AdoptionOffer[] = [];
  for (const c of classifications) {
    if (c.verdict.status !== "gone") continue;
    offers.push({
      source: c.claim.key,
      claimedAt: c.claim.claimedAt,
      confidence: c.verdict.confidence,
      reason: c.verdict.reason,
      agents: c.agents,
      hintMatchedDestination: undefined,
      sourceDirIdentity: c.claim.dirIdentity,
    });
  }
  return offers;
}

export interface UnavailableReport {
  readonly source: ClaimKey;
  readonly reason: string;
}

/** The Q1 "report and nothing else" half — never offered for adoption. */
export function buildUnavailableReports(classifications: readonly ClaimClassification[]): readonly UnavailableReport[] {
  const reports: UnavailableReport[] = [];
  for (const c of classifications) {
    if (c.verdict.status === "unavailable") reports.push({ source: c.claim.key, reason: c.verdict.reason });
  }
  return reports;
}

// --- Q2: the hint — ranks, never decides ------------------------------------

/**
 * Marks every offer whose SOURCE claim's recorded `dirIdentity` equals
 * `destinationIdentity` as hint-matched — a `{ dev, ino }` pair the caller
 * `stat()`'d at the CANDIDATE DESTINATION directory (which, unlike an
 * orphan's own vanished path, exists and can be stat'd directly; see
 * orphan-probe.ts's `probeDirectory`, whose `"exists"` branch is the normal
 * way to obtain this). A same-filesystem `mv` preserves the inode, so a
 * match here is a genuine (if not certain — see the module comment on
 * `classifyDirectory` and claim-model.ts's own `DirIdentity` doc for why
 * inode reuse makes this a hint, never a decision) signal that THIS
 * destination is where THAT orphan went.
 *
 * Pure ranking only: this function does not select anything, does not
 * reduce which agents must still be named explicitly, and does not shrink
 * the set of offers — every input offer is still present in the output,
 * matched or not. Nothing about this function's result can be treated as
 * "the answer"; it exists only to let a caller SORT or HIGHLIGHT a likely
 * match for an operator, never to skip naming the agents (B10) or the
 * explicit adopt call.
 */
export function applyDestinationHint(offers: readonly AdoptionOffer[], destinationIdentity: DirIdentity | undefined, destination: ClaimKey): readonly AdoptionOffer[] {
  if (destinationIdentity === undefined) return offers;
  return offers.map((offer) => {
    const recorded = offer.sourceDirIdentity;
    const matches = recorded !== undefined && recorded.dev === destinationIdentity.dev && recorded.ino === destinationIdentity.ino;
    return matches ? { ...offer, hintMatchedDestination: destination } : offer;
  });
}
