// BAKR-48: the impure half of `bakr status` — two reads, in parallel, and
// nothing else. The decisions all live in status-model.ts.
//
// STRICTLY READ-ONLY, and the reason is the whole point of the command: the
// dashboard polls this every ~10 seconds, so anything it did as a side effect
// would be done 8,640 times a day to a live herd.
//   - herdr: `agent list` ONCE, plus one `agent read` per Claude pane (drovr's
//     `listBlockingPrompts`). NO other herdr command — in particular NOT
//     `pane process-info`, which is why this does not reuse `herdrList`
//     (spawn/herdr.ts): that helper runs one process-info per pane for a pid
//     this report has no use for. The single listing is SHARED between the
//     pane inventory and drovr's scan, so polling costs one list and N reads.
//   - the store: one plain `load`, no lock at all. `save` is an atomic
//     temp+rename, so a reader sees either the whole old file or the whole new
//     one — never a torn write — and taking even a shared lock would let a
//     10-second poll contend with the daemon's own writes for no gain.
// Nothing here starts, wakes, restores, relaunches or stops anything, and
// nothing here writes a byte.
//
// The `hostResident` swap (BAKR-35): panes come from bakr's own herdr listing
// because drovr's `listResidents` lists only drovr-hosted workspaces. When
// BAKR-35 lands, `listPanes` below is the one function to replace.

import { emptyAgentStore, isSupersededStaleCwdRespawnFailure, type LaunchRecord } from "./agent-model";
import { load as loadAgents } from "./agent-store-io";
import { isRecognizedStaleCwdRefusal, type RunCommand } from "./spawn";
import { herdrApprovalClient, type ApprovalClient } from "./cli/herdr-transport";
import { buildStatusReport, type BlockingPromptInfo, type HerdrPane, type StatusInputs, type StatusReport } from "./status-model";
import { listBlockingPrompts } from "@brooswit/drovr";

export interface StatusDeps {
  readonly agentsPath: string;
  readonly runCommand: RunCommand;
  readonly now: () => number;
}

const message = (err: unknown): string => err instanceof Error ? err.message : String(err);

/**
 * One `herdr agent list`, however many callers ask for it. drovr's scan and
 * this module's own pane inventory both read a listing; memoizing the promise
 * means the poll pays for exactly one, and the two views can never disagree
 * about what was running at that instant.
 */
function sharedListingClient(runCommand: RunCommand): ApprovalClient {
  const client = herdrApprovalClient(runCommand);
  let listing: ReturnType<ApprovalClient["agent"]["list"]> | undefined;
  return { agent: { ...client.agent, list: () => (listing ??= client.agent.list()) } };
}

/**
 * Every Claude pane herdr is running, with the session id duplicates are
 * grouped by. A pane whose `agent_session` is a path rather than an id
 * (`kind: "path"`) names no session, so there is nothing to compare an agent's
 * `restoreTarget.sessionId` against and nothing to group it with — it is left
 * out rather than reported under an invented identity.
 */
export async function listPanes(client: ApprovalClient): Promise<HerdrPane[]> {
  const { agents } = await client.agent.list();
  const panes: HerdrPane[] = [];
  for (const agent of agents) {
    if (agent.agent !== "claude") continue;
    const session = agent.agent_session;
    if (session == null || session.kind !== "id" || typeof session.value !== "string") continue;
    panes.push({ paneId: agent.pane_id, sessionId: session.value, cwd: agent.cwd ?? undefined, herdrStatus: agent.agent_status });
  }
  return panes;
}

/** Reads herdr once (a listing plus one screen read per Claude pane) and reports the failure rather than throwing it. */
async function readHerdr(runCommand: RunCommand): Promise<StatusInputs["herdr"]> {
  const client = sharedListingClient(runCommand);
  try {
    const [panes, prompts] = await Promise.all([listPanes(client), listBlockingPrompts(client)]);
    const blocking: BlockingPromptInfo[] = prompts.map((p) => ({ paneId: p.paneId, sessionId: p.sessionId, herdrStatus: p.herdrStatus, kind: p.kind, name: p.name, excerpt: p.excerpt }));
    return { ok: true, panes, prompts: blocking };
  } catch (err) {
    return { ok: false, reason: message(err) };
  }
}

/** Reads the agent store once, without a lock, reporting a malformed or unreadable store rather than an empty one. */
async function readStore(agentsPath: string): Promise<StatusInputs["store"]> {
  try {
    const outcome = await loadAgents(agentsPath);
    if (outcome.status === "malformed") return { ok: false, reason: `the agent store could not be read: ${outcome.error}` };
    // A missing store is not a failed read: bakr has simply never created an
    // agent on this host. That is an empty, healthy herd, not an unknown one.
    return { ok: true, state: outcome.status === "loaded" ? outcome.state : emptyAgentStore() };
  } catch (err) {
    return { ok: false, reason: message(err) };
  }
}

/** The whole read-only health report. Neither read can fail the other: both are attempted, both report for themselves. */
export async function collectStatus(deps: StatusDeps): Promise<StatusReport> {
  const [herdr, store] = await Promise.all([readHerdr(deps.runCommand), readStore(deps.agentsPath)]);
  const isSuperseded = (record: LaunchRecord): boolean =>
    store.ok && isSupersededStaleCwdRespawnFailure(store.state, record, isRecognizedStaleCwdRefusal);
  return buildStatusReport({ checkedAt: deps.now(), herdr, store, isSuperseded });
}
