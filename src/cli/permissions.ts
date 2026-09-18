// `bakr <agent> permissions`: the tool-permission prompts waiting on one
// agent's pane. drovr's listPendingPermissions reads EVERY Claude pane on the
// host — other people's agents included — so what this module owns is the
// narrowing: an agent is shown its own pane's prompts and never another's.
// How panes are read is the host's business (herdr-transport.ts), injected
// through CliDeps as a PermissionHost; everything here is pure.

import type { PendingPermission } from "@brooswit/drovr";
import type { RestoreTarget } from "../agent-model";

/**
 * Where permission prompts are read. Only `list` today; answering one
 * (drovr's approvePermission) belongs beside it, on the same host.
 */
export interface PermissionHost {
  /** Every Claude pane on this host showing a tool-permission prompt — not only this agent's. */
  list(): Promise<PendingPermission[]>;
}

/**
 * The prompts on this agent's own pane, and no other. The session id decides
 * whenever the pane reports one: a pane showing some other session is some
 * other agent even if its pane id equals this agent's `shortId` (a stale
 * restore target, or a pane id herdr handed out again). Only a pane that
 * reports no session yet is matched by pane id alone.
 */
export function ownPendingPermissions(target: RestoreTarget, pending: readonly PendingPermission[]): PendingPermission[] {
  return pending.filter((p) => p.sessionId === undefined ? p.paneId === target.shortId : p.sessionId === target.sessionId);
}

/**
 * One block per prompt. The `promptId` line is printed verbatim on its own so
 * an operator can copy it into the command that answers the prompt; the
 * cursor's option is marked `>`.
 */
export function renderPendingPermissions(prompts: readonly PendingPermission[]): string {
  if (prompts.length === 0) return "no pending prompts\n";
  return prompts.map((p) => [
    `pane: ${p.paneId}`,
    `tool: ${p.tool}`,
    "request:",
    ...p.request.split("\n").map((line) => `  ${line}`),
    `question: ${p.question}`,
    "options:",
    ...p.options.map((option, i) => `  ${i === p.cursor ? ">" : " "} ${i + 1}. ${option}`),
    `promptId: ${p.promptId}`,
  ].join("\n")).join("\n\n") + "\n";
}
