import { describe, expect, test } from "bun:test";
import { filterExactCwd, parseAgentsJson, parseLaunchId, detectStaleRegisteredCwdRefusal } from "../../src/spawn/parse";

describe("parseAgentsJson", () => {
  test("keeps only kind: background entries, dropping interactive ones", () => {
    const raw = JSON.stringify([
      { pid: 1, cwd: "/a", kind: "interactive", startedAt: 1, sessionId: "s1", name: "x" },
      { pid: 2, id: "abc", cwd: "/b", kind: "background", startedAt: 2, sessionId: "s2", state: "blocked" },
    ]);
    expect(parseAgentsJson(raw)).toEqual([{ id: "abc", sessionId: "s2", cwd: "/b", startedAt: 2, pid: 2, state: "blocked" }]);
  });

  test("a background entry with no pid field parses with pid: undefined — the observed transient/stopped case, never coerced away", () => {
    const raw = JSON.stringify([{ id: "abc", cwd: "/b", kind: "background", startedAt: 2, sessionId: "s2", state: "stopped" }]);
    expect(parseAgentsJson(raw)).toEqual([{ id: "abc", sessionId: "s2", cwd: "/b", startedAt: 2, pid: undefined, state: "stopped" }]);
  });

  test("a background entry with no state field parses with state: undefined", () => {
    const raw = JSON.stringify([{ id: "abc", cwd: "/b", kind: "background", startedAt: 2, sessionId: "s2", pid: 42 }]);
    expect(parseAgentsJson(raw)).toEqual([{ id: "abc", sessionId: "s2", cwd: "/b", startedAt: 2, pid: 42, state: undefined }]);
  });

  test("skips a malformed individual entry rather than failing the whole parse", () => {
    const raw = JSON.stringify([
      { id: "good", cwd: "/b", kind: "background", startedAt: 2, sessionId: "s2" },
      { id: "bad", kind: "background" }, // missing cwd/startedAt/sessionId
    ]);
    expect(parseAgentsJson(raw)).toEqual([{ id: "good", sessionId: "s2", cwd: "/b", startedAt: 2, pid: undefined, state: undefined }]);
  });

  test("empty array in, empty array out", () => {
    expect(parseAgentsJson("[]")).toEqual([]);
  });

  test("throws, does not return [], on a non-array top level — an empty list here would be indistinguishable from a genuinely empty roster of sessions", () => {
    expect(() => parseAgentsJson(JSON.stringify({ error: "not logged in" }))).toThrow();
  });

  test("throws on invalid JSON", () => {
    expect(() => parseAgentsJson("not json")).toThrow();
  });
});

describe("parseAgentsJson — Constraint 1 hardening (BAKR-12): systematic vs. individual failure", () => {
  test("throws when every background entry fails validation (a systematic shape change), instead of returning []", () => {
    const raw = JSON.stringify([
      { id: "bad-1", kind: "background" }, // missing cwd/startedAt/sessionId
      { id: "bad-2", kind: "background" }, // same
    ]);
    expect(() => parseAgentsJson(raw)).toThrow(/none survived field validation/);
  });

  test("still returns [] when there are zero background candidates at all — nothing systematic to report", () => {
    const raw = JSON.stringify([{ pid: 1, cwd: "/a", kind: "interactive", startedAt: 1, sessionId: "s1", name: "x" }]);
    expect(parseAgentsJson(raw)).toEqual([]);
  });

  test("does not throw when at least one background entry survives, even if others fail — the individual-skip path is unaffected", () => {
    const raw = JSON.stringify([
      { id: "good", cwd: "/b", kind: "background", startedAt: 2, sessionId: "s2" },
      { id: "bad", kind: "background" },
    ]);
    expect(() => parseAgentsJson(raw)).not.toThrow();
    expect(parseAgentsJson(raw)).toHaveLength(1);
  });

  test("a single malformed background entry (the only one present) also throws — the systematic case is not gated on count", () => {
    const raw = JSON.stringify([{ id: "bad", kind: "background" }]);
    expect(() => parseAgentsJson(raw)).toThrow();
  });
});

describe("filterExactCwd", () => {
  const sessions = [
    { id: "a", sessionId: "sa", cwd: "/home/op/project", startedAt: 1, pid: 1, state: undefined },
    { id: "b", sessionId: "sb", cwd: "/home/op/project/sub", startedAt: 2, pid: 2, state: undefined },
  ];

  test("keeps only entries whose cwd is exactly equal, dropping subdirectory matches", () => {
    expect(filterExactCwd(sessions, "/home/op/project")).toEqual([sessions[0]!]);
  });

  test("returns an empty array when nothing matches exactly", () => {
    expect(filterExactCwd(sessions, "/nowhere")).toEqual([]);
  });
});

describe("parseLaunchId", () => {
  test("extracts the short id from the observed `backgrounded · <id> (...)` stdout line", () => {
    expect(parseLaunchId("backgrounded · 3e36ed78 (idle — send a prompt to start)\n")).toBe("3e36ed78");
  });

  test("ignores leading lines and only reads the backgrounded line", () => {
    const stdout = "Starting background service…\nbackgrounded · 561bb49c (idle — send a prompt to start)\n  claude agents             list sessions\n";
    expect(parseLaunchId(stdout)).toBe("561bb49c");
  });

  test("throws when the expected line is absent, rather than returning a wrong id", () => {
    expect(() => parseLaunchId("some unrelated output\n")).toThrow();
  });

  test("throws on empty stdout", () => {
    expect(() => parseLaunchId("")).toThrow();
  });
});

describe("detectStaleRegisteredCwdRefusal (BAKR-24)", () => {
  test("extracts the stale path from the observed exact wording", () => {
    const text = `launch exited 1: Couldn't start a background session (working directory no longer exists or is not accessible: /tmp/bakr-live-e2e/work1)`;
    expect(detectStaleRegisteredCwdRefusal(text)).toBe("/tmp/bakr-live-e2e/work1");
  });

  test("returns undefined for an unrelated launch failure — never a false positive", () => {
    expect(detectStaleRegisteredCwdRefusal("launch exited 1: systemd-run: permission denied")).toBeUndefined();
    expect(detectStaleRegisteredCwdRefusal("launch failed: ENOENT: no such file or directory, posix_spawn 'systemd-run'")).toBeUndefined();
  });

  test("returns undefined for empty text", () => {
    expect(detectStaleRegisteredCwdRefusal("")).toBeUndefined();
  });
});
