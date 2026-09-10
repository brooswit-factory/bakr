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
 * boolean. Three outcomes, kept distinct because they prove different
 * things:
 * - `alive` — a pid was independently verified against the OS just now.
 * - `not-verifiable` — the session IS listed, but either claude's daemon
 *   reported no pid for it this cycle, or the pid it reported did not
 *   verify as alive. NOT the same claim as "dead": candlestix's own
 *   agents-cli.ts doc comment (ported into parse.ts) records a real
 *   session that transiently lost its pid while being re-homed, without
 *   ever actually dying.
 * - `unknown` — the listing itself failed, or this session simply was not
 *   present in it. BAKR-11 §2 is explicit that "not visible in the
 *   listing" must NEVER be treated as proof of death: a wrong directory, a
 *   different Unix user, and a genuinely stopped session are all
 *   indistinguishable from each other at this API surface (measured:
 *   `claude agents --json --cwd <nonexistent>` prints `[]` and exits 0).
 */
export type LivenessVerdict =
  | { status: "alive"; pid: number }
  | { status: "not-verifiable"; reason: string }
  | { status: "unknown"; reason: string };

/**
 * Pure decision: given what a listing (or its absence) says about one
 * session id, and whether its reported pid independently verified,
 * produces the verdict above. No I/O — the caller (`checkLiveness` below)
 * is responsible for fetching the listing and calling `isPidAlive`; this
 * function only decides, which is what makes the decision itself
 * exhaustively unit-testable without mocking a listing or a process table.
 */
export function decideLiveness(id: string, entry: BackgroundSessionInfo | undefined, pidVerifiedAlive: boolean): LivenessVerdict {
  if (!entry) {
    return { status: "unknown", reason: `session "${id}" is not present in this listing — not proof of death (BAKR-11 §2)` };
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
 * failed listing becomes `unknown`, never an exception the caller must
 * separately handle and never a silent `dead`.
 */
export async function checkLiveness(id: string, deps: ListDeps): Promise<LivenessVerdict> {
  let sessions: BackgroundSessionInfo[];
  try {
    sessions = await listBackgroundSessions(deps);
  } catch (err) {
    return { status: "unknown", reason: `listing failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const entry = sessions.find((s) => s.id === id);
  const pidVerifiedAlive = entry?.pid !== undefined ? isPidAlive(entry.pid) : false;
  return decideLiveness(id, entry, pidVerifiedAlive);
}
