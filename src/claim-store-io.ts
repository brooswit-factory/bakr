// Durable, atomic persistence for the claim store (BAKR-10).
//
// Missing / malformed / loaded are three distinct, typed outcomes, never
// collapsed to two. This is the single most important shape in this file.
// The reasoning transfers wholesale from `brooswit-factory/candlestix`'s
// own module comment on this exact problem — but that comment lives in
// `src/agent-set-store.ts`, which is real code but only on candlestix's
// own unmerged branch `CNDLX-22` (`origin/CNDLX-22` @ 9a7f045), not on its
// `main` (verified at candlestix's `main` commit f43e543, where the file
// does not exist yet — candlestix is mid-flight, per this ticket's own
// words). That module's reasoning: the agent set (candlestix's analogue
// of this claim store) "is reconstructable from NOTHING. Silently
// returning 'empty' for a malformed file here would make every agent the
// operator ever created look deleted, and the next save would overwrite
// the very file that still held them" — data loss disguised as a default.
// The claim store is in exactly that position.
//
// A divergence from candlestix worth stating plainly: candlestix's OTHER,
// older store — `loadRegistry` in `src/registry-store.ts`, on `main` —
// logs a malformed file as an error but then *also* falls back to an
// empty registry, collapsing "malformed" into "missing" at the point
// where its caller decides what to do. That is a defensible choice for
// that specific file, because it has a live oracle to rebuild from
// (`claude agents --json`, cross-checked in reconcile.ts's adopt-by-cwd
// fallback) — losing the registry there is recoverable, per its own
// module comment ("Written under XDG_RUNTIME_DIR ... survives a daemon
// restart but not a reboot — matching the ticket's requirement exactly").
// bakr's claim store has no such oracle: a claim's existence lives
// nowhere but this file — the same position candlestix's own
// agent-set-store.ts is in, which is why THAT file (not registry-store.ts)
// is the one whose pattern this module actually follows. `load` below
// returns `malformed` as its own typed outcome and leaves the decision to
// the caller, exactly as this ticket asks for.
//
// Atomic write: temp file in the same directory, then `rename` — same
// pattern as `saveAgentSet` in that same `agent-set-store.ts` (see above
// for exactly which file/branch/commit). `rename` within one filesystem
// is atomic, so no reader ever observes a half-written store, and a
// process killed mid-write leaves the previous store intact.
//
// What the atomic write protects against, and what it does not: it
// protects against a process killed mid-write (the ordinary case this
// ticket cares about). It does NOT, by itself, protect against power
// loss — without an fsync of the temp file's data before the rename, and
// an fsync of the containing directory after it, a completed rename can
// be durable in the directory's metadata while the file's own data is
// still only in a volatile write-back cache. This module DOES both
// fsyncs (see `save` below) specifically so that gap is closed rather
// than merely disclosed.

import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type ClaimStoreState, parseClaimStoreState, serializeClaimStoreState } from "./claim-model";

export type LoadOutcome =
  | { readonly status: "missing" }
  | { readonly status: "malformed"; readonly error: string }
  | { readonly status: "loaded"; readonly state: ClaimStoreState };

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "ENOENT";
}

/**
 * A missing file at `path` is a SUCCESS (first run, empty store) — see
 * `status: "missing"`, never an error and never silently folded into
 * `"loaded"` with an empty state, so a caller can tell "never claimed
 * anything" apart from "loaded, and there is nothing in it" if it ever
 * needs to. A file that exists but cannot be read at all (e.g. EACCES) is
 * folded into `"malformed"` alongside bad JSON and a wrong shape — all
 * three are "not safely loadable", which is the one typed failure this
 * ticket asks `load` to report, left for the caller to decide about.
 */
export async function load(path: string): Promise<LoadOutcome> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (err) {
    if (isEnoent(err)) {
      return { status: "missing" };
    }
    return { status: "malformed", error: err instanceof Error ? err.message : String(err) };
  }

  const result = parseClaimStoreState(source);
  if (!result.ok) {
    return { status: "malformed", error: result.error };
  }
  return { status: "loaded", state: result.state };
}

/**
 * Atomic write: write + fsync a temp file in the same directory as
 * `path`, `rename` it into place, then fsync the containing directory so
 * the rename itself is durable too. See the module comment above for
 * exactly what this does and does not protect against.
 */
export async function save(path: string, state: ClaimStoreState): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });

  const tmpPath = join(dir, `.${randomUUID()}.tmp`);
  const fileHandle = await open(tmpPath, "w");
  try {
    await fileHandle.writeFile(serializeClaimStoreState(state), "utf8");
    await fileHandle.sync();
  } finally {
    await fileHandle.close();
  }

  await rename(tmpPath, path);

  const dirHandle = await open(dir, "r");
  try {
    await dirHandle.sync();
  } finally {
    await dirHandle.close();
  }
}
