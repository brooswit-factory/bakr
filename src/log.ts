// Minimal leveled logger. Ported near-verbatim from
// brooswit-factory/candlestix's src/log.ts (verified at candlestix's own
// commit 3801992aae149271e273a3ee48247978b1df6e8c) — pure line formatting
// kept separate from the `console.log` call so it can be asserted on
// directly, the same split that file's own comment gives.

export type LogLevel = "info" | "warn" | "error";

export function formatLogLine(level: LogLevel, message: string, at: Date = new Date()): string {
  return `[${at.toISOString()}] ${level.toUpperCase()} ${message}`;
}

export function log(level: LogLevel, message: string): void {
  console.log(formatLogLine(level, message));
}
