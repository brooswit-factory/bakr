import { describe, expect, test } from "bun:test";
import { filterExactCwd, parseAgentsJson, parseLaunchId } from "../../src/spawn/parse";

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
