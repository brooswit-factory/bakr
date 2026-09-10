import { describe, expect, test } from "bun:test";
import { listBackgroundSessions } from "../../src/spawn/list";

describe("listBackgroundSessions", () => {
  test("calls `claude agents --json` and parses the result", async () => {
    const calls: unknown[] = [];
    const result = await listBackgroundSessions({
      runCommand: async (argv, opts) => {
        calls.push({ argv, opts });
        return {
          exitCode: 0,
          stdout: JSON.stringify([{ id: "x", cwd: "/c", kind: "background", startedAt: 5, sessionId: "s" }]),
          stderr: "",
        };
      },
    });
    expect(calls).toEqual([{ argv: ["claude", "agents", "--json"], opts: { timeoutMs: 15_000 } }]);
    expect(result).toEqual([{ id: "x", sessionId: "s", cwd: "/c", startedAt: 5, pid: undefined, state: undefined }]);
  });

  test("underCwd is forwarded as --cwd", async () => {
    const calls: string[][] = [];
    await listBackgroundSessions(
      {
        runCommand: async (argv) => {
          calls.push(argv);
          return { exitCode: 0, stdout: "[]", stderr: "" };
        },
      },
      { underCwd: "/home/op/project" }
    );
    expect(calls[0]).toEqual(["claude", "agents", "--json", "--cwd", "/home/op/project"]);
  });

  test("throws on a non-zero exit rather than returning [] — a caller must be able to tell a failed listing apart from a genuinely empty one", async () => {
    await expect(listBackgroundSessions({ runCommand: async () => ({ exitCode: 1, stdout: "", stderr: "not logged in" }) })).rejects.toThrow(
      /not logged in/
    );
  });
});
