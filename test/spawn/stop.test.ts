import { describe, expect, test } from "bun:test";
import { stopSession } from "../../src/spawn/stop";

describe("stopSession", () => {
  test("stops by id alone — builds `claude stop <id>` and nothing else", async () => {
    const calls: Array<{ argv: string[]; opts: { timeoutMs: number } }> = [];
    const result = await stopSession("abc12345", {
      runCommand: async (argv, opts) => {
        calls.push({ argv, opts });
        return { exitCode: 0, stdout: "stopped abc12345\n", stderr: "" };
      },
    });
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([{ argv: ["claude", "stop", "abc12345"], opts: { timeoutMs: 15_000 } }]);
  });

  test("never touches systemctl, a scope unit, or a cgroup path — only ever `claude stop <id>`", async () => {
    let capturedArgv: string[] = [];
    await stopSession("abc12345", {
      runCommand: async (argv) => {
        capturedArgv = argv;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    expect(capturedArgv[0]).toBe("claude");
    expect(capturedArgv).not.toContain("systemctl");
    expect(capturedArgv.join(" ")).not.toMatch(/scope|cgroup|kill/i);
  });

  test("a non-zero exit (e.g. unknown id) is a stop failure, with the real output surfaced", async () => {
    const result = await stopSession("doesnotexist", {
      runCommand: async () => ({ exitCode: 1, stdout: "No job matching 'doesnotexist'.\n", stderr: "" }),
    });
    expect(result).toEqual({ ok: false, error: expect.stringContaining("No job matching") });
  });

  test("a thrown stop (e.g. a timeout) is a stop failure, not an unhandled rejection", async () => {
    const result = await stopSession("abc12345", {
      runCommand: async () => {
        throw new Error("command timed out after 15000ms");
      },
    });
    expect(result).toEqual({ ok: false, error: expect.stringContaining("timed out") });
  });
});
