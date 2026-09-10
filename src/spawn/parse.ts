// Pure parsing of everything this substrate reads back from `claude`: the
// short id `claude --bg` prints on launch, and the JSON array `claude
// agents --json` prints for listing. No I/O — see argv.ts's module comment
// for why that matters to BAKR-11's definition of done.

export interface BackgroundSessionInfo {
  /** Short id — what `claude attach|logs|stop|rm` take, and what stop.ts requires. */
  id: string;
  /** Full session UUID, as reported by `claude agents --json`. Not returned by launch() — the only source of it is a later listing. */
  sessionId: string;
  cwd: string;
  /** Epoch ms. */
  startedAt: number;
  /**
   * Absent, not merely null or zero, when claude's own daemon has no
   * resolvable backing OS process to report for this session right now.
   * Reasoning ported from candlestix's src/agents-cli.ts doc comment: an
   * absent pid was observed there as a transient state during a re-home,
   * never as proof the session had died — see liveness.ts for how this
   * substrate turns "no pid" into an honest verdict rather than a guess.
   */
  pid: number | undefined;
  /**
   * Raw `state` field as claude reports it. Observed values on this
   * substrate's own test host, 2026-09-10, claude 2.1.267: "blocked" (a
   * freshly launched, unprompted session) and "stopped" (after `claude
   * stop`) for background entries. Not documented anywhere in `claude
   * --help` as a closed enum, so this is carried through as an opaque,
   * forward-compatible string rather than pattern-matched against —
   * liveness.ts's own decision never reads it, it verifies `pid` directly
   * against the OS instead. Re-verify the observed values on your own
   * build before treating any specific one as meaningful.
   */
  state: string | undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Pure parser: JSON text in, typed list out. Filters to `kind ===
 * "background"` — measured as load-bearing, not decorative (BAKR-11 §5a,
 * re-verified on this substrate's own test host on 2026-09-10: a live
 * listing returned 32 entries, 19 of them `kind: "interactive"` — ordinary
 * foreground sessions belonging to this Unix user, including unrelated
 * agents of the surrounding fleet). An unfiltered list would treat those
 * as bakr's own and could hand one of them to stop().
 *
 * Throws on a non-array top level, ported from candlestix's
 * src/agents-cli.ts and for the same reason its own comment gives: this is
 * machine output from a specific CLI contract (`--json`), not hand-edited
 * input, so anything else means the read itself failed — an empty list
 * here would be indistinguishable from "nothing is running" and would risk
 * a caller spawning a duplicate next to a session that is, in fact, alive.
 * A malformed INDIVIDUAL entry is skipped rather than failing the whole
 * parse, same reasoning: one odd entry (a future claude version adding a
 * field, an entry mid-write) should not blind this substrate to every
 * other, valid entry.
 *
 * BAKR-12 hardening (Constraint 1 of the daemon story, BAKR-8): the
 * per-entry skip above is correct for a single odd entry, but not for the
 * SYSTEMATIC case — if a future `claude` renames or drops `id` (or any
 * other required field) on every entry, every `kind:"background"` entry
 * fails validation and this function used to return `[]` just like a
 * genuinely-empty listing would. A caller reading that `[]` cannot tell
 * "nothing is running" from "the parser can no longer read what claude is
 * telling it" — and boot restore is exactly where that ambiguity is most
 * dangerous: a spurious empty listing there means relaunching duplicates
 * beside sessions that are, in fact, alive (see the daemon's own restore
 * module). So: if the raw array contained at least one `kind ===
 * "background"` entry but NONE of them survived field validation, this now
 * throws instead of returning `[]` — matching this same file's own
 * discipline for a non-array top level. A raw array with zero background
 * entries to begin with is unaffected and still returns `[]` normally,
 * because there genuinely is nothing to report. This is a change to
 * merged, reviewed code (BAKR-11) — the throw-on-systematic-failure
 * behaviour did not exist before BAKR-12.
 */
export function parseAgentsJson(raw: string): BackgroundSessionInfo[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("expected `claude agents --json` to print a JSON array");
  }

  let backgroundCandidates = 0;
  const result: BackgroundSessionInfo[] = [];
  for (const item of parsed) {
    if (!isPlainObject(item)) continue;
    if (item["kind"] !== "background") continue;
    backgroundCandidates += 1;
    const { id, sessionId, cwd, startedAt } = item;
    if (typeof id !== "string" || typeof sessionId !== "string" || typeof cwd !== "string" || typeof startedAt !== "number") {
      continue;
    }
    const pid = typeof item["pid"] === "number" ? (item["pid"] as number) : undefined;
    const state = typeof item["state"] === "string" ? (item["state"] as string) : undefined;
    result.push({ id, sessionId, cwd, startedAt, pid, state });
  }

  if (backgroundCandidates > 0 && result.length === 0) {
    throw new Error(
      `\`claude agents --json\` listed ${backgroundCandidates} background entr${backgroundCandidates === 1 ? "y" : "ies"}, but none survived field validation — this looks like a systematic shape change (e.g. a renamed/dropped field), not one odd entry, so this is reported as a parse failure rather than an empty list (BAKR-12 Constraint 1)`
    );
  }

  return result;
}

/**
 * Explicit exact-directory filter over an already-fetched listing, kept
 * deliberately separate from `--cwd` (a subtree pre-filter — see argv.ts)
 * for the reason BAKR-11 §1 and §5b both name: nothing in this substrate
 * may resolve or adopt an agent by directory alone, and narrowing is not
 * the same claim as exact equality. This is a filter, never an identity
 * resolver — it can return more than one match, and a caller still owns
 * the decision of which one (if any) is "its" session; this function does
 * not make that call.
 */
export function filterExactCwd(sessions: BackgroundSessionInfo[], cwd: string): BackgroundSessionInfo[] {
  return sessions.filter((s) => s.cwd === cwd);
}

/**
 * Extracts the short id from `claude --bg`'s own stdout — the only place
 * that id is available at launch time. There is no `--json` output for
 * `--bg` itself; `claude agents --json` is the sole source of the full
 * `sessionId`, obtainable only via a later listing.
 *
 * This is text-format parsing of a human-facing message, not a documented
 * machine contract, unlike `parseAgentsJson` above — brittle to a wording
 * change in a future `claude` build. Isolating it to one pure function
 * bounds that risk to one place, and this function's own unit tests pin
 * the exact phrasing observed on 2026-09-10 against claude 2.1.267
 * (`backgrounded · <id> (idle — send a prompt to start)`, printed to
 * stdout; systemd-run's own "Running as unit…" / "Starting background
 * service…" lines went to stderr in that same observation) so a future
 * `claude` upgrade that changes the wording fails loudly here rather than
 * silently elsewhere.
 */
export function parseLaunchId(stdout: string): string {
  const match = stdout.match(/^backgrounded · (\S+)/m);
  if (!match || !match[1]) {
    throw new Error(`could not find a launched session id in \`claude --bg\` output: ${JSON.stringify(stdout)}`);
  }
  return match[1];
}
