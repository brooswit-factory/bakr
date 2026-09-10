// Durable, atomic persistence for the session slots store (BAKR-12).
// Mirrors claim-store-io.ts's own module exactly, including its module
// comment's reasoning, for the same reason: this file is in the identical
// position claim-store-io.ts's target is in, not a weaker one. The session
// slots store is reconstructable from NOTHING — nothing in bakr may
// resolve a session id from a directory alone (see session-slots.ts's own
// module comment), so there is no live oracle (unlike
// brooswit-factory/candlestix's registry-store.ts, which can fall back to
// empty because reconcile.ts's adopt-by-cwd rebuilds it from `claude`'s own
// state on the next cycle — a fallback this codebase's own hazard rules
// forbid porting). `load` below returns the identical three typed
// outcomes claim-store-io.ts's `load` does, and for the identical reason:
// the caller (the daemon's own startup path — see index.ts) decides what
// `malformed` means, and the chosen answer is the same one Constraint 3
// gives the claim store: start degraded, restore nothing derived from this
// file, and never write over it.
//
// Atomic write: temp file in the same directory, fsync, rename, fsync the
// directory — copied verbatim from claim-store-io.ts's own `save`, for the
// identical durability reasoning documented there.

import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type SessionSlotsState, parseSessionSlotsState, serializeSessionSlotsState } from "./session-slots";

export type LoadOutcome =
  | { readonly status: "missing" }
  | { readonly status: "malformed"; readonly error: string }
  | { readonly status: "loaded"; readonly state: SessionSlotsState };

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "ENOENT";
}

/** See claim-store-io.ts's `load` doc comment — identical discipline, applied to this file instead. */
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

  const result = parseSessionSlotsState(source);
  if (!result.ok) {
    return { status: "malformed", error: result.error };
  }
  return { status: "loaded", state: result.state };
}

/** See claim-store-io.ts's `save` doc comment — identical atomic-write dance, applied to this file instead. */
export async function save(path: string, state: SessionSlotsState): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });

  const tmpPath = join(dir, `.${randomUUID()}.tmp`);
  const fileHandle = await open(tmpPath, "w");
  try {
    await fileHandle.writeFile(serializeSessionSlotsState(state), "utf8");
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
