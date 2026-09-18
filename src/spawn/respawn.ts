// Bringing a stopped session back with its conversation. Under herdr that is
// `claude --resume <sessionId>` in a new pane: the SAME session id and
// transcript continue (measured: rocketr's 517fd13a resumed in a pane kept
// its id and history), and — unlike `claude respawn`, which re-used the flags
// a background session was first launched with — the restore carries the
// agent's CURRENT flags, so a changed channel reaches it on its next restore.

import type { RunCommand } from "./exec";
import { launch } from "./launch";

export interface RespawnDeps {
  runCommand: RunCommand;
  label?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface RespawnRequest {
  /** The session to continue — never a fork: a fork that is never prompted writes no transcript, and a later restore of it would find nothing to resume. */
  readonly sessionId: string;
  readonly directory: string;
  /** The agent's current launch flags (launch-config.ts). */
  readonly args: readonly string[];
}

/** `id` is the new pane id; the session id is unchanged. */
export type RespawnResult = { readonly ok: true; readonly id: string } | { readonly ok: false; readonly error: string };

export async function respawnSession(request: RespawnRequest, deps: RespawnDeps): Promise<RespawnResult> {
  const result = await launch(request.directory, ["--resume", request.sessionId, ...request.args], deps);
  return result.ok ? { ok: true, id: result.id } : { ok: false, error: result.error };
}

/** `claude respawn`'s stale-cwd refusal (BAKR-24). A resume in a pane never produces it; kept so callers' recovery branches stay total. */
export function isRecognizedStaleCwdRefusal(errorText: string): boolean {
  return /working directory no longer exists or is not accessible: /.test(errorText);
}

/** `claude respawn`'s missing-job refusal (BAKR-22). A resume in a pane never produces it; kept so callers' recovery branches stay total. */
export function isRecognizedMissingJobRefusal(errorText: string): boolean {
  return /No job matching/.test(errorText);
}
