import { describe, expect, test } from "bun:test";
import { resolveClaimKey, type ClaimKey, type Lstat, type ResolveInputs } from "../../src/claim-key-resolve";

class FakeEnoentError extends Error {
  readonly code = "ENOENT";
}

type FakeEntry = { readonly type: "dir" } | { readonly type: "symlink"; readonly target: string };

/** A tiny in-memory filesystem: every path this walk will lstat must have an explicit entry, same as a real filesystem requiring every path component to exist. */
function fakeFs(entries: Record<string, FakeEntry>): ResolveInputs {
  return {
    lstat: async (path: string): Promise<Lstat> => {
      const entry = entries[path];
      if (!entry) {
        throw new FakeEnoentError(`no such entry: ${path}`);
      }
      return { isSymbolicLink: () => entry.type === "symlink" };
    },
    readlink: async (path: string): Promise<string> => {
      const entry = entries[path];
      if (!entry || entry.type !== "symlink") {
        throw new Error(`EINVAL: not a symlink: ${path}`);
      }
      return entry.target;
    },
  };
}

describe("resolveClaimKey", () => {
  test("a path with no symlinks resolves to itself", async () => {
    const fs = fakeFs({ "/a": { type: "dir" }, "/a/b": { type: "dir" } });
    const result = await resolveClaimKey("/a/b", fs);
    expect(result).toEqual({ ok: true, key: "/a/b" as ClaimKey });
  });

  test("a nonexistent path is a typed 'does-not-exist' refusal, not a silently-normalized key", async () => {
    const fs = fakeFs({});
    const result = await resolveClaimKey("/nope", fs);
    expect(result).toEqual({ ok: false, reason: "does-not-exist", path: "/nope" });
  });

  test("a nonexistent intermediate component is also 'does-not-exist'", async () => {
    const fs = fakeFs({ "/a": { type: "dir" } });
    const result = await resolveClaimKey("/a/missing-child/x", fs);
    expect(result).toEqual({ ok: false, reason: "does-not-exist", path: "/a/missing-child/x" });
  });

  test("a symlink cycle is a typed 'resolve-failed', distinct from 'does-not-exist'", async () => {
    const fs = fakeFs({ "/a": { type: "dir" }, "/a/link": { type: "symlink", target: "/a/link" } });
    const result = await resolveClaimKey("/a/link", fs);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("resolve-failed");
    }
  });

  test("a symlink and its target — two genuinely different spellings of one directory — resolve to the SAME ClaimKey", async () => {
    const fs = fakeFs({
      "/a": { type: "dir" },
      "/a/link": { type: "symlink", target: "/a/target" },
      "/a/target": { type: "dir" },
    });
    const viaLink = await resolveClaimKey("/a/link", fs);
    const viaTarget = await resolveClaimKey("/a/target", fs);
    expect(viaLink.ok).toBe(true);
    expect(viaTarget.ok).toBe(true);
    if (viaLink.ok && viaTarget.ok) {
      expect(viaLink.key).toBe(viaTarget.key);
    }
  });

  test("`..` after a symlink resolves to the REAL parent of the symlink's target, not the link's own lexical parent", async () => {
    // Reproduces the exact case this module's own comment documents bun's
    // built-in realpath (both plain and `.native`) getting wrong.
    const fs = fakeFs({
      "/a": { type: "dir" },
      "/a/real-parent": { type: "dir" },
      "/a/real-parent/child": { type: "dir" },
      "/a/elsewhere": { type: "dir" },
      "/a/elsewhere/link": { type: "symlink", target: "/a/real-parent/child" },
    });
    const viaDotDot = await resolveClaimKey("/a/elsewhere/link/..", fs);
    const viaRealParent = await resolveClaimKey("/a/real-parent", fs);
    expect(viaDotDot.ok).toBe(true);
    expect(viaRealParent.ok).toBe(true);
    if (viaDotDot.ok && viaRealParent.ok) {
      expect(viaDotDot.key).toBe(viaRealParent.key);
    }
  });

  test("a relative symlink target resolves relative to the symlink's own containing directory", async () => {
    const fs = fakeFs({
      "/a": { type: "dir" },
      "/a/dir": { type: "dir" },
      "/a/dir/link": { type: "symlink", target: "sub" },
      "/a/dir/sub": { type: "dir" },
    });
    const result = await resolveClaimKey("/a/dir/link", fs);
    expect(result).toEqual({ ok: true, key: "/a/dir/sub" as ClaimKey });
  });

  test("a trailing slash does not change the resolved key", async () => {
    const fs = fakeFs({ "/a": { type: "dir" }, "/a/b": { type: "dir" } });
    const withSlash = await resolveClaimKey("/a/b/", fs);
    const without = await resolveClaimKey("/a/b", fs);
    expect(withSlash.ok).toBe(true);
    expect(without.ok).toBe(true);
    if (withSlash.ok && without.ok) {
      expect(withSlash.key).toBe(without.key);
    }
  });
});
