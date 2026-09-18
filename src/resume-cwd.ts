// Where a session must be resumed. Claude refuses `--resume <id>` from any
// directory but the one the conversation last ran in — measured on 2.1.276,
// it stops at "This conversation is from a different directory. To resume,
// run: …", a prompt no resident can answer. A session moves directory when it
// enters a git worktree (`<agent dir>/.claude/worktrees/<name>`), so an
// agent's own directory is not always right: factory-dashboard's session
// 800bbe16 had moved into its `first-slice` worktree, and resuming it from
// the agent directory blocked on that prompt (2026-09-18).
//
// The conversation's own transcript records the cwd of each turn. The last
// one is where it resumes, provided it still exists and lies inside the
// agent's own directory — never somewhere else on disk.

export interface ResumeCwdDeps {
  /** The `cwd` of the latest transcript record that has one, or `undefined` when the transcript cannot be found or read. Never throws. */
  readonly lastRecordedCwd: (sessionId: string) => Promise<string | undefined>;
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

/** The directory to resume `sessionId` in: its last recorded cwd when that is an existing directory inside `agentDirectory`, otherwise `agentDirectory`. */
export async function resumeCwdFor(sessionId: string, agentDirectory: string, deps: ResumeCwdDeps): Promise<string> {
  const recorded = await deps.lastRecordedCwd(sessionId);
  if (recorded === undefined || recorded === agentDirectory || !isWithin(recorded, agentDirectory)) return agentDirectory;
  return (await deps.isDirectory(recorded)) ? recorded : agentDirectory;
}
