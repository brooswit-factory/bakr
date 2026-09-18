// Operator messaging is provider-neutral: bakr names an agent's running
// session and prints its reply. How a message reaches that same session is
// the transport's business (Drovr's resident messenger in bin.ts), never a
// provider flag or command in bakr's grammar.

export interface ResidentTarget {
  // bakr's spawn substrate launches only Claude background sessions today.
  provider: "claude";
  sessionId: string;
  cwd: string;
}

export interface ResidentMessenger {
  message(target: ResidentTarget, text: string): Promise<{ status: "replied" | "reply-pending"; reply: string }>;
}

/** A transport refusal: nothing was delivered, or delivery could not be proven. Never a fallback session. */
export function residentRefusal(e: unknown): { reason: string; message: string } | undefined {
  if (!(e instanceof Error) || e.name !== "ResidentMessageRefusal") return undefined;
  const reason = (e as Error & { reason?: unknown }).reason;
  return typeof reason === "string" ? { reason, message: e.message } : undefined;
}

export type ResidentCwd =
  | { ok: true; cwd: string }
  | { ok: false; reason: "not-running" | "outside-directory" | "ambiguous-session"; message: string };

/**
 * Where the agent's exact session is running now, as claude lists it. A
 * session can move its own cwd after launch (entering a git worktree under
 * `.claude/worktrees/` is the observed case), and claude keys both its
 * listing and its transcript on that current cwd — so the transport must be
 * handed it, not the directory bakr launched into. The session is still
 * matched by its exact id; the cwd is accepted only inside the agent's own
 * directory, never a guess about some other session.
 */
export function resolveResidentCwd(directory: string, sessionId: string, sessions: readonly { sessionId: string; cwd: string }[]): ResidentCwd {
  const listed = sessions.filter(s => s.sessionId === sessionId);
  if (!listed.length) return { ok: false, reason: "not-running", message: `its exact session ${sessionId} is not a running background session` };
  if (listed.some(s => s.cwd === directory)) return { ok: true, cwd: directory };
  const inside = [...new Set(listed.map(s => s.cwd).filter(cwd => cwd.startsWith(`${directory}/`)))];
  if (inside.length === 1) return { ok: true, cwd: inside[0]! };
  if (inside.length > 1) return { ok: false, reason: "ambiguous-session", message: `its exact session ${sessionId} is listed in more than one directory: ${inside.join(", ")}` };
  return { ok: false, reason: "outside-directory", message: `its exact session ${sessionId} is running outside the agent's directory ${directory}: ${listed.map(s => s.cwd).join(", ")}` };
}
