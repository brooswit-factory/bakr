import { describe, expect, test } from "bun:test";
import { isHerdrPaneId, listBackgroundSessions } from "../../src/spawn/list";
import { makeFakeHost } from "../support/fake-host";

describe("listBackgroundSessions", () => {
  test("lists herdr panes by pane id, with claude's own session id and pid", async () => {
    const host = makeFakeHost();
    host.addPane({ cwd: "/c", sessionId: "s1", pid: 42, status: "working" });
    expect(await listBackgroundSessions({ runCommand: host.runCommand })).toEqual([
      { id: "w1:p1", sessionId: "s1", cwd: "/c", startedAt: 0, pid: 42, state: "working" },
    ]);
  });

  test("also lists legacy `claude --bg` sessions, so a daemon never resumes one in a pane while it still runs", async () => {
    const host = makeFakeHost();
    host.legacy.push({ id: "abcd1234", sessionId: "s-legacy", cwd: "/c", startedAt: 5, kind: "background", pid: 7 });
    const sessions = await listBackgroundSessions({ runCommand: host.runCommand });
    expect(sessions).toEqual([{ id: "abcd1234", sessionId: "s-legacy", cwd: "/c", startedAt: 5, pid: 7, state: undefined }]);
    expect(isHerdrPaneId(sessions[0]!.id)).toBe(false);
  });

  test("underCwd narrows to sessions at or under the directory, never a sibling with a shared prefix", async () => {
    const host = makeFakeHost();
    host.addPane({ cwd: "/home/op/project", sessionId: "a" });
    host.addPane({ cwd: "/home/op/project/.claude/worktrees/x", sessionId: "b" });
    host.addPane({ cwd: "/home/op/project-other", sessionId: "c" });
    const sessions = await listBackgroundSessions({ runCommand: host.runCommand }, { underCwd: "/home/op/project" });
    expect(sessions.map((s) => s.sessionId)).toEqual(["a", "b"]);
  });

  test("throws rather than returning [] — a caller must be able to tell a failed listing apart from a genuinely empty one", async () => {
    await expect(listBackgroundSessions({ runCommand: makeFakeHost({ failListing: true }).runCommand })).rejects.toThrow(/listing failure/);
    const legacyDown = makeFakeHost();
    const runCommand = async (argv: string[], o: { timeoutMs: number }) =>
      argv[0] === "claude" ? { exitCode: 1, stdout: "", stderr: "not logged in" } : legacyDown.runCommand(argv, o);
    await expect(listBackgroundSessions({ runCommand })).rejects.toThrow(/not logged in/);
  });

  test("pane ids and legacy short ids are told apart by shape", () => {
    expect(isHerdrPaneId("w12:p3")).toBe(true);
    expect(isHerdrPaneId("3e36ed78")).toBe(false);
  });
});
