// THE SOLE SITE IN THIS SUBSTRATE THAT RESPAWNS A SESSION (BAKR-22). Ported
// in shape from stop.ts — `claude respawn <shortId>` and nothing else; this
// file, and argv.ts's buildRespawnInvocation which it calls, are the only
// two places in this substrate that construct a respawn invocation.
//
// WHY THIS EXISTS, raw measurement on BAKR-22's own ticket: `claude --bg
// --resume <fullId>` forks on at least one still-supported claude build
// (2.1.251) even under bakr's own exact invocation shape (a bare original
// launch, later given a real turn via `attach`, then silently restored) —
// BAKR-18's original defect, confirmed real, not a probe artifact.
// `claude respawn <shortId>` does not fork on ANY build measured (2.1.251,
// 2.1.268, and across a build change): same session id every time, full
// content retention, and — measured against the session's own cumulative
// `totalCostUSD`, the instrument this epic settled on after an
// assistant-usage-entry count proved blind to a helper-model side call —
// no new model-turn cost on a cleanly-completed prior turn. B8 (no turn
// spent per agent per boot) holds for that case.
//
// THE INTERRUPTED-TOOL-CALL COST QUESTION IS A REACHABILITY ARGUMENT, NOT
// A MEASUREMENT — stated as such, with its assumption named, per the
// epic's own framing. A `kill -9` on the pid `claude agents --json`
// reports does NOT stop an in-flight tool call for a `"backend":"daemon"`
// job (measured: the command ran to completion after the reported pid was
// confirmed dead) — the shared `claude daemon run` singleton executes it
// independently, and this substrate is forbidden from touching that
// singleton to test the genuine case. So the reachability argument: a
// session with a tool call genuinely in flight was, in every trial run,
// still LISTED (merely without a verifiable pid) — never absent from the
// listing. Enumerate `decideLiveness`'s three verdicts against that: pid
// alive -> `alive`, never respawned; listed with no verifiable pid ->
// `not-verifiable`, never respawned; ONLY absence from the listing ->
// `unknown` reaches respawn/forkFrom. If "a session executing work is
// always listed" holds, the cost question cannot arise through bakr's own
// restore path AT ALL — only a manual, out-of-band `respawn` could reach
// it. That assumption is supported by every trial this ticket ran, not
// proven for every case.
//
// `respawn` on a session that is `alive` or `not-verifiable` kills and
// restarts its process (measured: the pid changes) — an unannounced stop
// hidden inside "restore", exactly what B7 forbids. THERE IS NO "dead"
// VERDICT `decideLiveness` can produce (liveness.ts has exactly
// `alive | not-verifiable | unknown`, and `unknown`'s own doc comment says
// plainly it is "not proof of death") — so the gate every caller of this
// file must apply is "reachable only on `unknown`", the same weak link the
// old `--bg --resume` restore path already acted on, not a stronger
// guarantee this file introduces. Nothing in this file re-checks it, by
// design (this file, like stop.ts, is a thin, pure argv wrapper — the
// liveness decision belongs to daemon.ts / agent-actions.ts, which both
// re-verify immediately before calling this, as close to the call as
// B12's "never hold the lock across a spawn" allows).

import type { RunCommand } from "./exec";
import { buildRespawnInvocation } from "./argv";
import { detectStaleRegisteredCwdRefusal } from "./parse";

export interface RespawnDeps {
  runCommand: RunCommand;
}

export type RespawnResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

/**
 * Respawns a background session by its own recorded SHORT id — `respawn`
 * rejects a full session uuid outright (measured: `"No job matching
 * '<uuid>'"`, rc=1). Synchronous: unlike `launch()`, there is no later
 * listing needed to learn a session id, because `respawn` never changes
 * one (see `resolveRespawnAttempt` in agent-model.ts).
 */
export async function respawnSession(shortId: string, deps: RespawnDeps): Promise<RespawnResult> {
  const invocation = buildRespawnInvocation(shortId);
  try {
    const result = await deps.runCommand(invocation.argv, { timeoutMs: invocation.timeoutMs });
    if (result.exitCode !== 0) {
      return {
        ok: false,
        error: `respawn exited ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim() || "(no output)"}`,
      };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `respawn failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * THE ONE RECOGNISED `respawn` FAILURE SHAPE that transitions to a
 * `forkFrom` — reused, not reinvented: `detectStaleRegisteredCwdRefusal`
 * (parse.ts) already pins the exact text `--bg --resume` was measured to
 * fail with when a job's registered cwd no longer exists, and BAKR-22
 * measured `respawn` failing with the SAME text for the SAME cause. Text
 * pinned as observed on claude 2.1.268, 2026-09-11 — see that function's
 * own doc. ANY OTHER non-zero result (unknown job, an ambiguous short-id
 * prefix, anything unrecognised) must NOT reach this predicate as true:
 * this is the rule that keeps "fork on a guess" from ever happening —
 * forking when the failure meant something else would abandon a live
 * conversation and silently mint a new one. Callers must refuse loudly on
 * `false`, never fall through to `forkFrom`.
 */
export function isRecognizedStaleCwdRefusal(errorText: string): boolean {
  return detectStaleRegisteredCwdRefusal(errorText) !== undefined;
}

/**
 * BAKR-22, the epic's "missing job" condition: if claude has removed the
 * job entry entirely (its own bookkeeping, not anything bakr owns —
 * observed after `claude rm`, or plausibly after claude's own retention
 * policy expires an old job), `respawn` refuses with exactly this shape —
 * measured, and pinned the same way `isRecognizedStaleCwdRefusal` pins its
 * own text. Text observed on claude 2.1.268, 2026-09-11: `"No job matching
 * '<id>'"`, rc=1 — the SAME shape a full-uuid rejection produces (BAKR-22
 * also measured that `respawn` rejects a full session uuid this way), so
 * this predicate cannot itself distinguish "the job never existed" from
 * "the job existed and is now gone" — callers must not read a `true` here
 * as proof either way, only as "there is genuinely no job to respawn".
 *
 * UNLIKE `isRecognizedStaleCwdRefusal`, this is NOT wired into the
 * reconcile loop's automatic dispatch (daemon.ts) — B7/B13: the loop's
 * give-up stays final, and forking automatically on "job missing" (as
 * opposed to "cwd stale") is a materially different, less-verified claim
 * about WHY the job is gone. It is wired only into the explicit,
 * operator-initiated `on` (agent-actions.ts) — the recovery route the
 * epic asked for: an operator who can see the job is simply gone gets an
 * explicit, reported way back to the conversation (a `forkFrom` of the
 * agent's current `restoreTarget.sessionId`, gated by
 * `hasResumableTranscript` exactly like the stale-cwd escape), never
 * something the unattended loop decides on its own.
 */
export function isRecognizedMissingJobRefusal(errorText: string): boolean {
  return /No job matching/.test(errorText);
}
