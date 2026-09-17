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
