// `bakr <agent> permissions` and `approve`: the tool-permission prompts
// waiting on one agent's pane, and answering one of them. drovr's
// listPendingPermissions reads EVERY Claude pane on the host — other people's
// agents included — so what this module owns is the narrowing: an agent is
// shown, and can approve, its own pane's prompts and never another's. How
// panes are read and answered is the host's business (herdr-transport.ts),
// injected through CliDeps as a PermissionHost; everything here is pure.

import type { ApprovePermissionRefusalReason, ApprovePermissionRequest, ApprovePermissionResult, PendingPermission, PermissionScope } from "@brooswit/drovr";
import type { RestoreTarget } from "../agent-model";
import { EXIT_FAILURE, EXIT_REFUSAL } from "./exit-codes";

/** Where permission prompts are read, and answered. */
export interface PermissionHost {
  /** Every Claude pane on this host showing a tool-permission prompt — not only this agent's. */
  list(): Promise<PendingPermission[]>;
  /**
   * drovr's approvePermission: re-reads the pane, refuses a changed prompt,
   * audits before any key, verifies the prompt cleared, never auto mode.
   * The caller decides which pane — always one `ownPendingPermissions` gave it.
   */
  approve(request: ApprovePermissionRequest): Promise<ApprovePermissionResult>;
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

/** Who is approving: `--as` when typed, else `$USER`; undefined when neither names anyone, which the CLI refuses before any pane is read. */
export function resolveOperator(as: string | undefined, user: string | undefined): string | undefined {
  const operator = as ?? user;
  return operator === undefined || operator.trim() === "" ? undefined : operator;
}

export type OwnPrompt =
  | { ok: true; prompt: PendingPermission }
  | { ok: false; reason: "no-prompt" | "prompt-changed"; detail: string };

/**
 * The prompt the operator named, only if it is pending on this agent's own
 * pane (`ownPendingPermissions`). The pane approved is the one that prompt is
 * on, never one the operator typed, so pasting another agent's promptId finds
 * nothing here, and a promptId that has gone stale is refused before drovr is
 * reached. drovr re-reads the pane and checks the id again before any key.
 */
export function findOwnPrompt(target: RestoreTarget, pending: readonly PendingPermission[], promptId: string, who: string): OwnPrompt {
  const own = ownPendingPermissions(target, pending);
  const prompt = own.find((p) => p.promptId === promptId);
  if (prompt !== undefined) return { ok: true, prompt };
  if (own.length === 0) return { ok: false, reason: "no-prompt", detail: `${who}'s pane shows no permission prompt, so ${promptId} is not pending there` };
  return { ok: false, reason: "prompt-changed", detail: `${promptId} is not pending on ${who}'s pane, which shows ${own.map((p) => p.promptId).join(", ")}; list again and approve that one` };
}

/** What was approved, so the operator has it on screen as well as in the audit. */
export function renderApproval(who: string, result: { tool: string; request: string; scope: PermissionScope; attemptId: string }, auditPath: string): string {
  const scope = result.scope === "always" ? "always: a rule stored for this project, which outlives the session" : "once";
  return [
    `approved ${result.tool} for ${who} (${scope})`,
    "request:",
    ...result.request.split("\n").map((line) => `  ${line}`),
    `attempt ${result.attemptId}, recorded in ${auditPath}`,
  ].join("\n") + "\n";
}

/** Keys that may have been sent without a confirmed answer, or an audit that could not be written, are failures; every other refusal is a refusal. */
export const approvalExitCode = (reason: ApprovePermissionRefusalReason): number => reason === "audit-failed" || reason === "not-cleared" ? EXIT_FAILURE : EXIT_REFUSAL;
