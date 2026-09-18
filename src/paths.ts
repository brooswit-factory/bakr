import { homedir } from "node:os";
import { join } from "node:path";
import { lstat, readdir, readFile, readlink, stat } from "node:fs/promises";
import { randomBytes as nodeRandomBytes } from "node:crypto";
import * as xdg from "./xdg";
import type { ResolveInputs } from "./claim-key-resolve";
import type { OrphanProbeDeps } from "./orphan-probe";
import type { TranscriptProbeDeps } from "./transcript-probe";
import type { LaunchConfigDeps } from "./launch-config";
import { formatLogLine } from "./log";

// The impure seams for this ticket's two real-filesystem dependencies:
// XDG resolution and symlink-aware path resolution. Both read real env/os
// values or touch the real filesystem exactly once per call and hand the
// result to the pure logic in xdg.ts / claim-key-resolve.ts. Kept separate
// so every path-shape decision stays unit-testable without touching
// `process.env` or the real filesystem — the same seam candlestix draws
// with its own src/paths.ts (verified at candlestix's own commit; ported
// as a pattern).
//
// `lstat`/`readlink`, not `realpath`: see claim-key-resolve.ts's module
// comment for why a single injected `realpath` was tried first and found
// to be wrong on this project's own runtime (bun 1.3.14 diverges from
// POSIX on `..` after a symlink, in both its plain and `.native` form).
// `lstat` and `readlink` are simple enough wrappers over individual
// syscalls that they were not found to have that class of bug.

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}

export function currentXdgInputs(): xdg.XdgInputs {
  return {
    home: homedir(),
    stateHome: nonEmpty(process.env["XDG_STATE_HOME"]),
  };
}

export const claimsPath = (): string => xdg.claimsPath(currentXdgInputs());
export const sessionSlotsPath = (): string => xdg.sessionSlotsPath(currentXdgInputs());
export const agentsPath = (): string => xdg.agentsPath(currentXdgInputs());

/** The real `lstat`/`readlink`, for wiring into `resolveClaimKey` (see claim-key-resolve.ts). */
export const realResolveInputs: ResolveInputs = {
  lstat: (path: string) => lstat(path),
  readlink: (path: string) => readlink(path),
};

/** The real CSPRNG source, for wiring into `mintAgentId`/`mintUniqueAgentId` (see agent-model.ts) — never called directly from anywhere pure. */
export const realRandomBytes = (byteLength: number): Uint8Array => nodeRandomBytes(byteLength);

/** The real `stat`, for wiring into `probeDirectory` (see orphan-probe.ts) — follows symlinks deliberately (see that module's own comment). */
export const realOrphanProbeDeps: OrphanProbeDeps = {
  stat: async (path: string) => {
    const s = await stat(path);
    return { dev: s.dev, ino: s.ino, isDirectory: () => s.isDirectory() };
  },
};

/** The real read-only filesystem access for `probeResumableTranscript` (transcript-probe.ts) — Claude Code's own `~/.claude/projects/` tree. Reading is permitted; nothing here ever writes. ONLY confirmed absence reads as "not found": `ENOENT` on a specific `<sessionId>.jsonl` file, or that file existing but not being a regular file. A missing/unreadable projects ROOT, or any other error (e.g. `EACCES`) checking an individual directory, is surfaced as `{ok:false}` — `could-not-tell`, never folded into "not found" — per that module's own explicit correction away from a boolean. */
export const realTranscriptProbeDeps: TranscriptProbeDeps = {
  listProjectDirs: async () => {
    try {
      const dirs = await readdir(join(homedir(), ".claude", "projects"));
      return { ok: true, dirs };
    } catch (err) {
      // The projects root not existing at ALL is treated as could-not-tell,
      // not as "confirmed zero projects": by the time this probe ever
      // runs, the agent in question has already launched at least once
      // (it has a `restoreTarget`), so its OWN project directory should
      // exist — a missing root more likely means an unexpected layout
      // (a different XDG/home configuration, a claude version that stores
      // transcripts elsewhere) than a genuinely empty install. See the
      // module comment: this is exactly the layout risk that motivates
      // `could-not-tell` existing as a real outcome, not a theoretical one.
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  },
  transcriptExistsIn: async (projectDir: string, sessionId: string) => {
    try {
      const s = await stat(join(homedir(), ".claude", "projects", projectDir, `${sessionId}.jsonl`));
      return { ok: true, exists: s.isFile() && s.size > 0 };
    } catch (err) {
      // ENOENT here is the ORDINARY case — this specific project directory
      // simply does not contain this session's transcript, which is
      // confirmed absence for THIS directory, not a failure to check it.
      // Anything else (EACCES, EIO, ...) is a genuine could-not-tell.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { ok: true, exists: false };
      }
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  },
};

/** The real access behind `claudeLaunchArgs` (launch-config.ts): reads a directory's own `.mcp.json` (absent or unreadable resolves to `undefined` — configuration this cannot read must never fail a launch), writes approvals through drovr's own settings IO, and reports what it could not do on stderr. */
export const realLaunchConfigDeps: LaunchConfigDeps = {
  readConfigFile: async (path: string) => {
    try {
      return await readFile(path, "utf8");
    } catch {
      return undefined;
    }
  },
  warn: (message: string) => console.error(formatLogLine("warn", message)),
};
