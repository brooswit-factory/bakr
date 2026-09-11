// BAKR-22, the epic's "never-spoken-to-then-moved" condition: `forkFrom`
// (the stale-cwd escape) mints a NEW session silently regardless of
// whether its SOURCE session ever had a transcript — measured on the
// ticket: the mint itself never errors, but the fork later fails outright
// ("source session <id> not found") the first time anyone actually gives
// it a prompt, if the source never had one. For an agent that was never
// spoken to before its directory moved, there is no conversation to lose,
// so `fresh` (a brand-new session in the new directory) is strictly
// better than a `forkFrom` that is a landmine waiting for the first real
// prompt — this file is the one check that tells the two cases apart.
//
// THREE-VALUED, NOT BOOLEAN — the epic's own correction, and the reason
// matters more than the shape: a boolean cannot express "I could not look"
// (an unreadable `~/.claude/projects/`, an unexpected layout, a transient
// I/O error), so it silently collapses that case into whichever branch is
// cheaper to fall through to. Here that cheaper branch is `no-transcript`
// -> `fresh` -> **permanently, silently abandoning a real conversation** —
// worse than the phantom-fork failure this whole mechanism exists to
// avoid, because the phantom at least fails LOUDLY the first time anyone
// prompts it, while a false `fresh` looks like success. Mirrors the same
// discipline `decideLiveness` (alive/not-verifiable/absent) and BAKR-18's
// orphan classification (present/gone/unavailable) already established in
// this tree: "could not confirm" is never folded into either confirmed
// answer.
//
// Reading Claude Code's own storage is explicitly permitted by this epic
// (only WRITING into it is forbidden) — this module only ever reads.
//
// Deliberately does NOT reconstruct Claude's own cwd -> project-slug
// algorithm (observed, on this ticket, to have edge cases — a directory
// containing dots was seen mapped two different ways across builds/hosts)
// — reconstructing it wrong would silently under- or over-report a
// transcript's existence. Instead this SEARCHES every project directory
// for a file named `<sessionId>.jsonl`, which needs no assumption about
// the slug at all. `~/.claude/projects/` can hold many entries (thousands,
// observed) but this check runs only on the rare stale-cwd escape path,
// never in a hot loop. THIS REDUCES THE LAYOUT RISK, IT DOES NOT REMOVE
// IT — an unreadable projects root, or a session whose transcript lives
// somewhere this search genuinely cannot reach, both still exist as
// possibilities, which is exactly why `could-not-tell` is a real outcome
// here and not a theoretical one.

export type TranscriptProbeResult =
  | { readonly status: "has-transcript" }
  | { readonly status: "no-transcript" }
  | { readonly status: "could-not-tell"; readonly reason: string };

export interface TranscriptProbeDeps {
  /**
   * Lists the names of every entry directly under the projects root.
   * MUST distinguish "the root does not exist / is not readable" from "it
   * exists and is empty" — see `TranscriptListOutcome` below. A real
   * implementation (paths.ts's `realTranscriptProbeDeps`) reads the actual
   * `~/.claude/projects/` directory; a fake for tests returns a fixed list
   * or a `failed` outcome to exercise `could-not-tell`.
   */
  readonly listProjectDirs: () => Promise<TranscriptListOutcome>;
  /**
   * Whether `<projectsRoot>/<projectDir>/<sessionId>.jsonl` exists and is a
   * regular, non-empty file. MUST distinguish "confirmed absent" from
   * "could not check this one" (e.g. a permission error on this specific
   * directory) — again via a typed outcome, never a bare boolean.
   */
  readonly transcriptExistsIn: (projectDir: string, sessionId: string) => Promise<TranscriptCheckOutcome>;
}

export type TranscriptListOutcome = { readonly ok: true; readonly dirs: readonly string[] } | { readonly ok: false; readonly reason: string };
export type TranscriptCheckOutcome = { readonly ok: true; readonly exists: boolean } | { readonly ok: false; readonly reason: string };

/**
 * Three-valued, never a boolean — see the module comment for why. Returns
 * `has-transcript` the instant a match is found (never keeps searching
 * past a hit, so a `could-not-tell` on a LATER directory after an earlier
 * confirmed hit does not downgrade the answer — a found transcript is a
 * found transcript). Returns `could-not-tell` the instant listing the
 * root itself fails, OR the instant any individual directory's check
 * fails without a transcript having already been found — "I searched
 * everywhere and confirmed none of them have it" (`no-transcript`) is a
 * STRONGER claim than "I searched some of them", so a single unreadable
 * directory poisons the whole answer rather than being silently skipped.
 * This function itself never touches the filesystem — see
 * `realTranscriptProbeDeps` (paths.ts) for the real implementation, kept
 * separate so this decision stays unit-testable without a real
 * `~/.claude/projects/` tree.
 */
export async function probeResumableTranscript(sessionId: string, deps: TranscriptProbeDeps): Promise<TranscriptProbeResult> {
  const listing = await deps.listProjectDirs();
  if (!listing.ok) {
    return { status: "could-not-tell", reason: `could not list the projects root: ${listing.reason}` };
  }

  for (const dir of listing.dirs) {
    const check = await deps.transcriptExistsIn(dir, sessionId);
    if (!check.ok) {
      return { status: "could-not-tell", reason: `could not check "${dir}" for a transcript: ${check.reason}` };
    }
    if (check.exists) {
      return { status: "has-transcript" };
    }
  }
  return { status: "no-transcript" };
}
