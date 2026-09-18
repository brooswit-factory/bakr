// Where a session must be resumed. Claude refuses `--resume <id>` from any
// directory but the one the conversation last ran in — measured on 2.1.276,
// it stops at "This conversation is from a different directory. To resume,
// run: …", a prompt no resident can answer. A session moves directory when it
// enters a git worktree (`<agent dir>/.claude/worktrees/<name>`), so an
// agent's own directory is not always right: factory-dashboard's session
// 800bbe16 had moved into its `first-slice` worktree, and resuming it from
// the agent directory blocked on that prompt (2026-09-18).
//
// The conversation's own transcript records the cwd of each turn, but the
// last cwd is not always the session's directory: a shell `cd` moves it too.
// Measured 2026-09-18: the manager (agent dir ~/code/brooswit-factory) last
// ran a command in ~/code/brooswit-factory/bakr, a separate repo inside it,
// and resuming there loaded bakr's project memory and settings. What Claude
// itself treats as the session's directory is the project folder its
// transcript lives in (`~/.claude/projects/<key>`): entering a worktree moves
// the transcript to the worktree's key, a `cd` does not. So the resume
// directory is the last cwd, or the nearest ancestor of it inside the agent's
// own directory, whose key is that folder's — never somewhere else on disk.

/** Claude's project folder name for a directory: every character but letters and digits becomes `-`. */
export const projectKeyOf = (directory: string): string => directory.replace(/[^a-zA-Z0-9]/g, "-");

export interface ResumeCwdDeps {
  /** The `cwd` of the latest transcript record that has one, or `undefined` when the transcript cannot be found or read. Never throws. */
  readonly lastRecordedCwd: (sessionId: string) => Promise<string | undefined>;
  /** The `~/.claude/projects` folder name holding the session's transcript, or `undefined` when not found. Never throws. When absent, the recorded cwd is trusted as before. */
  readonly transcriptProjectKey?: (sessionId: string) => Promise<string | undefined>;
  /** Whether a path is an existing directory. Never throws. */
  readonly isDirectory: (path: string) => Promise<boolean>;
}

/** The latest `cwd` in a transcript's JSONL text, or `undefined`. Unparseable lines are skipped. */
export function lastCwdIn(transcript: string): string | undefined {
  const lines = transcript.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.includes('"cwd"')) continue;
    try {
      const cwd = (JSON.parse(line) as { cwd?: unknown }).cwd;
      if (typeof cwd === "string" && cwd.length > 0) return cwd;
    } catch {
      // A partial last line (the session was writing) or foreign data: keep looking.
    }
  }
  return undefined;
}

/** Whether `path` is `dir` or inside it — never a sibling that merely shares a prefix. */
export const isWithin = (path: string, dir: string): boolean => path === dir || path.startsWith(dir.endsWith("/") ? dir : `${dir}/`);

/**
 * The directory to resume `sessionId` in: the last recorded cwd, or its
 * nearest ancestor inside `agentDirectory`, whose project key is the folder
 * the transcript lives in — when that directory exists. Otherwise
 * `agentDirectory`. Without a known transcript folder, the recorded cwd itself
 * is used when it exists inside `agentDirectory`.
 */
export async function resumeCwdFor(sessionId: string, agentDirectory: string, deps: ResumeCwdDeps): Promise<string> {
  const recorded = await deps.lastRecordedCwd(sessionId);
  if (recorded === undefined || recorded === agentDirectory || !isWithin(recorded, agentDirectory)) return agentDirectory;
  const key = await deps.transcriptProjectKey?.(sessionId);
  if (key === undefined) return (await deps.isDirectory(recorded)) ? recorded : agentDirectory;
  for (let dir = recorded; dir !== agentDirectory && isWithin(dir, agentDirectory); dir = dir.slice(0, dir.lastIndexOf("/"))) {
    if (projectKeyOf(dir) === key) return (await deps.isDirectory(dir)) ? dir : agentDirectory;
  }
  return agentDirectory;
}
