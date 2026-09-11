// Direct OS-level liveness check, deliberately independent of any
// third-party registry's say-so (`claude agents --json` included) — per
// BAKR-11 §2's rule: liveness is a positive fact confirmed against the OS,
// never an inference from the absence of an error.
//
// `isPidAlive` is ported unchanged from candlestix's src/proc.ts. The
// verdict type and `decideLiveness` below are new for this ticket:
// candlestix's own callers only ever needed a boolean (its reconcile.ts
// folds the not-verifiable/unknown distinction into its own action enum
// instead), while BAKR-11 §2 explicitly forbids collapsing this into one.

import type { BackgroundSessionInfo } from "./parse";
import type { ListDeps } from "./list";
import { listBackgroundSessions } from "./list";

export function isPidAlive(pid: number): boolean {
  try {
    // Signal 0 sends nothing; it only asks the kernel whether the pid is
    // signalable. This is a liveness PROBE, never a termination mechanism
    // — BAKR-11 §0/§9 forbid killing anything to stop a session, and
    // nothing in this substrate calls process.kill with a real signal.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but is owned by someone else — still
    // alive, just not signalable by this Unix user. Any other error
    // (ESRCH, chiefly) means it does not exist.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * BAKR-11 §2's requirement: liveness must never collapse to a bare
 * boolean. Kept as FOUR distinct outcomes (BAKR-22 split `unknown` in two
 * — see that ticket's own incident: a listing FAILURE and a listing that
 * SUCCEEDED but did not find the session were conflated under one
 * `unknown` status, and a caller written against `decideLiveness` alone
 * could not tell them apart even in principle, because `decideLiveness`
 * never sees which one happened — only `entry: undefined` either way. A
 * respawn-style gate that (correctly) treats "not alive" as "safe to act
 * on" would, under the OLD shape, also treat "the listing itself just
 * failed" as safe to act on — killing and restarting a session an
 * operator is actively using, caused by a transient CLI hiccup rather
 * than any fact about that session):
 * - `alive` — a pid was independently verified against the OS just now.
 * - `not-verifiable` — the session IS listed, but either claude's daemon
 *   reported no pid for it this cycle, or the pid it reported did not
 *   verify as alive. NOT the same claim as "dead": candlestix's own
 *   agents-cli.ts doc comment (ported into parse.ts) records a real
 *   session that transiently lost its pid while being re-homed, without
 *   ever actually dying.
 * - `absent` — the listing SUCCEEDED and this session simply was not
 *   present in it. BAKR-11 §2 is explicit that this must NEVER be treated
 *   as proof of death: a wrong directory, a different Unix user, and a
 *   genuinely stopped session are all indistinguishable from each other at
 *   this API surface (measured: `claude agents --json --cwd <nonexistent>`
 *   prints `[]` and exits 0). It remains the ONLY verdict a respawn-style
 *   gate may act on — the weakest link in the restore path, unchanged by
 *   this split, just no longer sharing a name with a DIFFERENT weak case.
 * - `listing-failed` — the listing call itself threw. Structurally
 *   IMPOSSIBLE for `decideLiveness` (below) to ever produce: it is pure,
 *   takes an already-resolved `entry`, and never sees a raw failure. Only
 *   `checkLiveness`'s own catch block can produce it, which is what makes
 *   "a gate that calls `decideLiveness` directly cannot accidentally act
 *   on a listing failure" true by construction rather than by convention.
 */
export type LivenessVerdict =
  | { status: "alive"; pid: number }
  | { status: "not-verifiable"; reason: string }
  | { status: "absent"; reason: string }
  | { status: "listing-failed"; reason: string };

/**
 * Pure decision: given what a listing says about one session id (the
 * caller must have already fetched it successfully — see the module
 * comment on why this function structurally cannot produce
 * `listing-failed`), and whether its reported pid independently verified,
 * produces the verdict above. No I/O — the caller (`checkLiveness` below)
 * is responsible for fetching the listing and calling `isPidAlive`; this
 * function only decides, which is what makes the decision itself
 * exhaustively unit-testable without mocking a listing or a process table.
 *
 * THE RETURN TYPE IS THE GUARANTEE, NOT DECORATION: `Exclude<LivenessVerdict,
 * {status:"listing-failed"}>` means the TYPE CHECKER, not a reviewer's
 * memory, is what stops a caller from treating "the listing itself threw"
 * as some ordinary liveness fact — this function is pure and never sees a
 * raw failure, so it is structurally incapable of producing that case. A
 * caller that widens this signature back to plain `LivenessVerdict` (e.g.
 * to "simplify" a call site, or while refactoring `checkLiveness`) is not
 * relaxing a type — it is REMOVING the guarantee that a respawn-style gate
 * built on `decideLiveness` alone can never act on a transient listing
 * failure (see BAKR-22's own incident: exactly this conflation, in
 * `daemon.ts`'s pre-spawn TOCTOU re-check, caused a thrown listing to be
 * treated as "safe to respawn" — a live agent could be killed and
 * restarted by a CLI hiccup that said nothing about that session at all).
 * If you are widening this signature, you are very likely reintroducing
 * that incident; use `checkLiveness` instead, which is what CAN observe a
 * real failure and reports it as its own `listing-failed` case.
 */
export function decideLiveness(id: string, entry: BackgroundSessionInfo | undefined, pidVerifiedAlive: boolean): Exclude<LivenessVerdict, { status: "listing-failed" }> {
  if (!entry) {
    return { status: "absent", reason: `session "${id}" is not present in this listing — not proof of death (BAKR-11 §2)` };
  }
  if (entry.pid === undefined) {
    return { status: "not-verifiable", reason: `session "${id}" is listed but claude's daemon reported no pid for it this cycle` };
  }
  if (!pidVerifiedAlive) {
    return { status: "not-verifiable", reason: `session "${id}" reported pid ${entry.pid}, which did not independently verify as alive` };
  }
  return { status: "alive", pid: entry.pid };
}

/**
 * Effectful glue: fetches the current listing, looks up `id`, verifies its
 * pid directly against the OS, and hands the result to `decideLiveness`. A
 * failed listing becomes its OWN verdict, `listing-failed` — never folded
 * into `absent`, never an exception the caller must separately handle, and
 * never a silent "safe to act on".
 */
export async function checkLiveness(id: string, deps: ListDeps): Promise<LivenessVerdict> {
  let sessions: BackgroundSessionInfo[];
  try {
    sessions = await listBackgroundSessions(deps);
  } catch (err) {
    return { status: "listing-failed", reason: `listing failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const entry = sessions.find((s) => s.id === id);
  const pidVerifiedAlive = entry?.pid !== undefined ? isPidAlive(entry.pid) : false;
  return decideLiveness(id, entry, pidVerifiedAlive);
}
