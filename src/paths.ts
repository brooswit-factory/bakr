import { homedir } from "node:os";
import { lstat, readlink } from "node:fs/promises";
import { randomBytes as nodeRandomBytes } from "node:crypto";
import * as xdg from "./xdg";
import type { ResolveInputs } from "./claim-key-resolve";

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
