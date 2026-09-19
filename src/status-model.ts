// BAKR-48: the pure half of `bakr status` — everything the report says,
// decided from values, with no clock, filesystem, herdr or store coupling of
// its own (same discipline as agent-model.ts). The impure half (status.ts)
// reads herdr and the store once each and hands the results here.
//
// THE RULE THIS FILE EXISTS TO ENFORCE, above every other rule in it:
// "couldn't check" is never "down". A read that failed produces `ok: null`
// and a reason on the failing check, NEVER a `problem` on an agent — see
// `buildStatusReport`'s own doc and the falsifier test that holds it.

import type { AgentLifecycleState, AgentStoreState, LaunchRecord } from "./agent-model";

/** Whether one of the two reads this report is built from succeeded, and why not when it didn't. */
export type Check = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * One Claude pane herdr is running, as this report reads a listing. Only the
 * fields the report needs — deliberately NOT `BackgroundSessionInfo`, whose
 * `pid` would cost a `herdr pane process-info` per pane (a command this
 * read-only report must not run; see status.ts).
 */
export interface HerdrPane {
  readonly paneId: string;
  /** `agent_session.value` — the one identity duplicates are grouped by, the same as DROVR-13. */
  readonly sessionId: string;
  readonly cwd: string | undefined;
  /** herdr's own `agent_status`, carried through verbatim. */
  readonly herdrStatus: string;
}

/** A dialog a pane is waiting on, as drovr's `listBlockingPrompts` reports one. */
export interface BlockingPromptInfo {
  readonly paneId: string;
  readonly sessionId: string | undefined;
  readonly herdrStatus: string;
  readonly kind: BlockedOn;
  readonly name: string | undefined;
  readonly excerpt: string;
}

/** drovr's `BlockingPromptKind`, one definition across bakr, drovr and the dashboard. */
export type BlockedOn = "startup" | "permission" | "unknown";

/**
 * Why an `on` agent is not the one healthy thing it should be: exactly one
 * herdr pane running its `restoreTarget.sessionId`, and that pane being its
 * `restoreTarget.shortId`.
 *
 * - `not-in-herdr`   — no pane runs its session, and nothing explains why.
 * - `wrong-session`  — its recorded pane exists but runs someone else's
 *                      session, and its own session runs nowhere.
 * - `wrong-pane`     — its session runs, in a pane that is not the recorded one.
 * - `duplicate-session` — more than one pane runs its session (the
 *                      lead-dynamic-atmosphere case this ticket was opened for).
 * - `restore-refused` — not running, and an unresolved launch record explains
 *                      it: a restore was attempted and never resolved (BAKR-33).
 * - `blocked`        — alive, in the right pane, and stuck on a dialog.
 * - `argv-mismatch`  — alive, in the right pane, but its claude was not
 *                      started with the flags bakr launches it with now
 *                      (BAKR-61: herdr's bare `claude --resume <id>` after a
 *                      reboot — no channels, so the agent is deaf). Checked
 *                      only on an agent nothing above already explains.
 */
export type ProblemCode = "not-in-herdr" | "wrong-session" | "wrong-pane" | "duplicate-session" | "restore-refused" | "blocked" | "argv-mismatch";

export interface Problem {
  readonly code: ProblemCode;
  readonly text: string;
}

export interface AgentStatus {
  readonly id: string;
  readonly name: string | null;
  readonly state: AgentLifecycleState;
  readonly directory: string;
  /** The pane actually running this agent's session, or its recorded `shortId` when nothing runs it. `null` when herdr could not be read or it has never launched. */
  readonly pane: string | null;
  /** `restoreTarget.sessionId` — what bakr would restore, not what any pane happens to show. */
  readonly sessionId: string | null;
  readonly herdrStatus: string | null;
  readonly blockedOn: BlockedOn | null;
  /** `true` healthy, `false` a problem, `null` NOT CHECKABLE — an `off`/`archived` agent, or a read that failed. Never `false` because a read failed. */
  readonly ok: true | false | null;
  readonly problem: Problem | null;
}

export interface DuplicateSession {
  readonly sessionId: string;
  readonly panes: readonly string[];
}

export interface OrphanPane {
  readonly pane: string;
  readonly sessionId: string;
}

export interface UnresolvedLaunch {
  readonly agentId: string;
  readonly attemptId: string;
  /** ISO 8601, the same spelling as `checkedAt` — never raw epoch ms, so the whole document reads one way. */
  readonly attemptedAt: string;
  readonly error: string;
}

export interface BlockedPromptReport {
  readonly pane: string;
  readonly agentId: string | null;
  readonly kind: BlockedOn;
  readonly name: string | null;
  readonly excerpt: string;
}

export const STATUS_SCHEMA_VERSION = 1;

export interface StatusReport {
  readonly version: typeof STATUS_SCHEMA_VERSION;
  readonly checkedAt: string;
  readonly herdr: Check;
  readonly store: Check;
  /** BAKR-61: whether every otherwise-healthy `on` agent's live argv could be read. `ok: false` names the panes that could not be; those agents are `ok: null`. */
  readonly argv: Check;
  readonly agents: readonly AgentStatus[];
  readonly duplicates: readonly DuplicateSession[];
  readonly orphanPanes: readonly OrphanPane[];
  readonly unresolvedLaunches: readonly UnresolvedLaunch[];
  readonly blockedPrompts: readonly BlockedPromptReport[];
}

export interface StatusInputs {
  readonly checkedAt: number;
  /** The herdr listing, or why it could not be read. */
  readonly herdr: { readonly ok: true; readonly panes: readonly HerdrPane[]; readonly prompts: readonly BlockingPromptInfo[] } | { readonly ok: false; readonly reason: string };
  /** The agent store, or why it could not be read. */
  readonly store: { readonly ok: true; readonly state: AgentStoreState } | { readonly ok: false; readonly reason: string };
  /**
   * Whether a failed launch record has since been superseded by a successful
   * one (`isSupersededStaleCwdRespawnFailure`). Injected rather than imported
   * so this file keeps no dependency on the spawn substrate's string
   * recognizers — the same seam `isSupersededStaleCwdRespawnFailure` itself
   * takes for `isRecognizedStaleCwdRefusal`.
   */
  readonly isSuperseded: (record: LaunchRecord) => boolean;
}

/**
 * Which prompt, if any, is this agent's own. The same rule `ownPendingPermissions`
 * (cli/permissions.ts) already applies, for the same reason: a pane that reports
 * a session must report THIS agent's session even when its pane id matches, and
 * only a pane reporting no session at all is matched by pane id alone.
 */
function promptFor(prompts: readonly BlockingPromptInfo[], sessionId: string, shortId: string): BlockingPromptInfo | undefined {
  return prompts.find((p) => p.sessionId === undefined ? p.paneId === shortId : p.sessionId === sessionId);
}

/** Groups values under a key without the `get ?? set` dance being written out five times. */
function push<K, V>(into: Map<K, V[]>, key: K, value: V): void {
  const existing = into.get(key);
  if (existing === undefined) into.set(key, [value]);
  else existing.push(value);
}

/**
 * Decides one `on` agent's verdict from what herdr actually showed.
 *
 * `target` is `undefined` for an agent that has never resolved a session —
 * newly created, or every launch so far having failed. That flows through the
 * same branches rather than a special case: no session means no pane runs it
 * and no pane is recorded for it, so it lands on `restore-refused` when a
 * launch record explains it and `not-in-herdr` when nothing does. An `on`
 * agent that is not running is not running; a pending attempt is named in the
 * text rather than reported as health it does not have.
 */
function diagnose(
  target: { readonly sessionId: string; readonly shortId: string } | undefined,
  panes: readonly HerdrPane[],
  unresolved: readonly LaunchRecord[],
  pending: readonly LaunchRecord[],
  blockedOn: BlockedOn | null
): { readonly pane: string | null; readonly problem: Problem | null } {
  const sessionId = target?.sessionId;
  const shortId = target?.shortId ?? null;
  const running = sessionId === undefined ? [] : panes.filter((p) => p.sessionId === sessionId);
  if (running.length > 1) {
    const ids = running.map((p) => p.paneId).join(", ");
    return { pane: running[0]!.paneId, problem: { code: "duplicate-session", text: `session ${sessionId} is running in ${running.length} panes at once: ${ids}` } };
  }
  if (running.length === 1) {
    const pane = running[0]!;
    if (pane.paneId !== shortId) {
      return { pane: pane.paneId, problem: { code: "wrong-pane", text: `session ${sessionId} is running in pane ${pane.paneId}, but bakr's record says pane ${shortId}` } };
    }
    if (blockedOn !== null) {
      return { pane: pane.paneId, problem: { code: "blocked", text: `pane ${pane.paneId} is alive but waiting on a ${blockedOn} dialog` } };
    }
    return { pane: pane.paneId, problem: null };
  }
  const recorded = shortId === null ? undefined : panes.find((p) => p.paneId === shortId);
  if (recorded !== undefined) {
    return { pane: shortId, problem: { code: "wrong-session", text: `pane ${shortId} is running session ${recorded.sessionId}, not this agent's session ${sessionId}, which is running nowhere` } };
  }
  const nothingRuns = sessionId === undefined ? "this agent has never resolved a session to restore" : `no herdr pane is running session ${sessionId}`;
  const refused = unresolved[0];
  if (refused !== undefined) {
    return { pane: shortId, problem: { code: "restore-refused", text: `${nothingRuns}, and launch attempt ${refused.attemptId} never resolved: ${refused.error}` } };
  }
  const inFlight = pending[0];
  const note = inFlight === undefined ? "" : `; launch attempt ${inFlight.attemptId} is still in flight`;
  return { pane: shortId, problem: { code: "not-in-herdr", text: `${nothingRuns}${note}` } };
}

/**
 * The whole report, from two reads and a clock reading.
 *
 * "COULDN'T CHECK" IS NOT "DOWN" (the consumer's hard requirement 2, and the
 * one this file's falsifier test targets): a failed herdr read leaves every
 * agent `ok: null` with `problem: null` and the reason on `herdr`, never a
 * `not-in-herdr` problem. A failed store read leaves `agents` empty — bakr
 * has no other source of truth for which agents exist, and inventing one
 * from a listing is exactly what this product forbids — with the reason on
 * `store`. Neither failure is ever reported as an absence.
 *
 * `orphanPanes` needs BOTH reads: a pane is orphaned relative to the set of
 * `on` agents, so with no store there is nothing to be orphaned from and the
 * list is empty rather than "every pane". `duplicates` and `blockedPrompts`
 * need only herdr and survive a store failure intact.
 */
export function buildStatusReport(inputs: StatusInputs): StatusReport {
  const checkedAt = new Date(inputs.checkedAt).toISOString();
  const herdrCheck: Check = inputs.herdr.ok ? { ok: true } : { ok: false, reason: inputs.herdr.reason };
  const storeCheck: Check = inputs.store.ok ? { ok: true } : { ok: false, reason: inputs.store.reason };
  const panes = inputs.herdr.ok ? inputs.herdr.panes : [];
  const prompts = inputs.herdr.ok ? inputs.herdr.prompts : [];
  const state = inputs.store.ok ? inputs.store.state : undefined;

  const unresolvedByAgent = new Map<string, LaunchRecord[]>();
  const pendingByAgent = new Map<string, LaunchRecord[]>();
  const unresolvedLaunches: UnresolvedLaunch[] = [];
  for (const record of state?.launches ?? []) {
    if (record.error === undefined) { push(pendingByAgent, record.agentId, record); continue; }
    if (inputs.isSuperseded(record)) continue;
    push(unresolvedByAgent, record.agentId, record);
    unresolvedLaunches.push({ agentId: record.agentId, attemptId: record.attemptId, attemptedAt: new Date(record.attemptedAt).toISOString(), error: record.error });
  }

  const agents: AgentStatus[] = [];
  for (const agent of Object.values(state?.agents ?? {}).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    const target = agent.restoreTarget;
    const prompt = inputs.herdr.ok && target !== undefined ? promptFor(prompts, target.sessionId, target.shortId) : undefined;
    const blockedOn = prompt?.kind ?? null;
    // Field order is the documented order of the schema, so the JSON reads the
    // way the README's sketch of it does.
    const identity = { id: agent.id, name: agent.name ?? null, state: agent.state, directory: agent.directory as string };
    const observation = (pane: string | null, herdrStatus: string | null, seen: BlockedOn | null) =>
      ({ ...identity, pane, sessionId: target?.sessionId ?? null, herdrStatus, blockedOn: seen });
    if (!inputs.herdr.ok) {
      // THE RULE: herdr could not be read, so nothing was observed — no pane,
      // no status, no blockedOn, and above all no problem. `ok: null`.
      agents.push({ ...observation(null, null, null), ok: null, problem: null });
      continue;
    }
    if (agent.state !== "on") {
      // Reported, never judged: bakr does not keep an off or archived agent
      // running, so nothing about herdr can make one unhealthy.
      const pane = target === undefined ? undefined : panes.find((p) => p.sessionId === target.sessionId);
      agents.push({ ...observation(pane?.paneId ?? null, pane?.herdrStatus ?? null, blockedOn), ok: null, problem: null });
      continue;
    }
    const verdict = diagnose(target, panes, unresolvedByAgent.get(agent.id) ?? [], pendingByAgent.get(agent.id) ?? [], blockedOn);
    const pane = panes.find((p) => p.paneId === verdict.pane);
    agents.push({ ...observation(verdict.pane, pane?.herdrStatus ?? null, blockedOn), ok: verdict.problem === null, problem: verdict.problem });
  }

  const bySession = new Map<string, string[]>();
  for (const pane of panes) push(bySession, pane.sessionId, pane.paneId);
  const duplicates: DuplicateSession[] = [...bySession].filter(([, ids]) => ids.length > 1).map(([sessionId, ids]) => ({ sessionId, panes: ids }));

  const ownedSessions = new Set(Object.values(state?.agents ?? {}).filter((a) => a.state === "on" && a.restoreTarget !== undefined).map((a) => a.restoreTarget!.sessionId));
  const orphanPanes: OrphanPane[] = state === undefined ? [] : panes.filter((p) => !ownedSessions.has(p.sessionId)).map((p) => ({ pane: p.paneId, sessionId: p.sessionId }));

  const agentBySession = new Map(Object.values(state?.agents ?? {}).filter((a) => a.restoreTarget !== undefined).map((a) => [a.restoreTarget!.sessionId, a.id]));
  const agentByPane = new Map(Object.values(state?.agents ?? {}).filter((a) => a.restoreTarget !== undefined).map((a) => [a.restoreTarget!.shortId, a.id]));
  const blockedPrompts: BlockedPromptReport[] = prompts.map((p) => ({
    pane: p.paneId,
    agentId: (p.sessionId === undefined ? agentByPane.get(p.paneId) : agentBySession.get(p.sessionId)) ?? null,
    kind: p.kind,
    name: p.name ?? null,
    excerpt: p.excerpt,
  }));

  return { version: STATUS_SCHEMA_VERSION, checkedAt, herdr: herdrCheck, store: storeCheck, argv: { ok: true }, agents, duplicates, orphanPanes, unresolvedLaunches, blockedPrompts };
}

/**
 * What reading one agent's live argv found (BAKR-61): it matches, it does not
 * (`reason` names every difference), or it could not be read or compared
 * (`ok: null` — couldn't check, never a mismatch).
 */
export type ArgvObservation = { readonly ok: true } | { readonly ok: false; readonly reason: string } | { readonly ok: null; readonly reason: string };

/**
 * The agents `applyArgvVerdicts` judges: `on`, and healthy by every other
 * check, so the argv is read only where a pane runs the agent's own session and
 * nothing else already explains a problem. Their argv is read from `pane`.
 */
export const argvCandidates = (report: StatusReport): readonly AgentStatus[] =>
  report.agents.filter((a) => a.state === "on" && a.ok === true && a.pane !== null && a.sessionId !== null);

/**
 * Folds argv observations, keyed by agent id, into the report. A mismatch
 * makes the agent `ok: false` with `argv-mismatch`; an observation that could
 * not be made makes it `ok: null` and fails the top-level `argv` check, so the
 * exit code is 2 — the same "couldn't check is not down" rule as a failed
 * herdr read, never a clean bill of health it has not earned. An agent with
 * no observation is left exactly as it was.
 */
export function applyArgvVerdicts(report: StatusReport, observed: ReadonlyMap<string, ArgvObservation>): StatusReport {
  const unreadable: string[] = [];
  const agents = report.agents.map((agent): AgentStatus => {
    const seen = observed.get(agent.id);
    if (seen === undefined || agent.ok !== true) return agent;
    if (seen.ok === true) return agent;
    if (seen.ok === null) {
      unreadable.push(`${agent.id} (pane ${agent.pane}): ${seen.reason}`);
      return { ...agent, ok: null, problem: null };
    }
    return { ...agent, ok: false, problem: { code: "argv-mismatch", text: `pane ${agent.pane} is running session ${agent.sessionId} without the flags bakr launches it with: ${seen.reason}` } };
  });
  const argv: Check = unreadable.length === 0 ? { ok: true } : { ok: false, reason: `could not check the live argv of ${unreadable.join("; ")}` };
  return { ...report, argv, agents };
}

export const EXIT_STATUS_HEALTHY = 0;
export const EXIT_STATUS_PROBLEMS = 1;
export const EXIT_STATUS_UNCHECKABLE = 2;

/**
 * 0 healthy, 1 problems found, 2 something could not be checked — and 2 wins,
 * because a report that could not see everything must never be read as a
 * clean bill of health. `ok: false` on an agent is the ONE thing that means
 * "problems found": duplicates, orphan panes and blocked prompts that belong
 * to no bakr agent are context, not bakr's own health (a host runs Claude
 * panes bakr does not own), and anything that does belong to a bakr agent
 * always also lands on that agent as a `problem`.
 */
export function statusExitCode(report: StatusReport): number {
  if (!report.herdr.ok || !report.store.ok || !report.argv.ok) return EXIT_STATUS_UNCHECKABLE;
  return report.agents.some((a) => a.ok === false) ? EXIT_STATUS_PROBLEMS : EXIT_STATUS_HEALTHY;
}

/** The same data as `--json`, short enough to read on a terminal. One line per agent, then only the sections that have something in them. */
export function renderStatusText(report: StatusReport): string {
  const lines: string[] = [`checked at ${report.checkedAt}`];
  if (!report.herdr.ok) lines.push(`herdr: COULD NOT CHECK — ${report.herdr.reason}`);
  if (!report.store.ok) lines.push(`store: COULD NOT CHECK — ${report.store.reason}`);
  if (!report.argv.ok) lines.push(`argv: COULD NOT CHECK — ${report.argv.reason}`);
  if (report.agents.length === 0) lines.push("no agents");
  for (const agent of report.agents) {
    const mark = agent.ok === true ? "ok" : agent.ok === false ? "PROBLEM" : "not checked";
    const name = agent.name === null ? "" : ` "${agent.name}"`;
    const where = agent.pane === null ? "" : ` pane ${agent.pane}`;
    lines.push(`${agent.id}${name} — ${agent.state} —${where} — ${mark}${agent.problem === null ? "" : `: ${agent.problem.code}: ${agent.problem.text}`}`);
  }
  for (const d of report.duplicates) lines.push(`duplicate session ${d.sessionId}: ${d.panes.join(", ")}`);
  for (const o of report.orphanPanes) lines.push(`orphan pane ${o.pane} (session ${o.sessionId}) belongs to no on agent`);
  for (const u of report.unresolvedLaunches) lines.push(`unresolved launch ${u.attemptId} for ${u.agentId} at ${u.attemptedAt}: ${u.error}`);
  for (const b of report.blockedPrompts) lines.push(`blocked pane ${b.pane}${b.agentId === null ? "" : ` (${b.agentId})`}: ${b.kind}${b.name === null ? "" : ` ${b.name}`}`);
  return `${lines.join("\n")}\n`;
}
