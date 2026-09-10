import { describe, expect, test } from "bun:test";
import { launch } from "../../src/spawn/launch";

describe("launch", () => {
  test("launches via a per-launch systemd-run --user --scope wrapping claude --bg, under the given directory, and returns the printed id", async () => {
    const commands: Array<{ argv: string[]; opts: { cwd?: string; timeoutMs: number } }> = [];

    const result = await launch("/home/op/project", ["--append-system-prompt", "watch this repo"], {
      generateUnitSuffix: () => "deadbeef",
      runCommand: async (argv, opts) => {
        commands.push({ argv, opts });
        return { exitCode: 0, stdout: "backgrounded · abc12345 (idle — send a prompt to start)\n", stderr: "" };
      },
    });

    expect(result).toEqual({ ok: true, id: "abc12345" });
    expect(commands).toHaveLength(1);
    const call = commands[0]!;
    expect(call.argv[0]).toBe("systemd-run");
    expect(call.argv).toContain("--unit=bakr-launch-deadbeef");
    expect(call.argv).toContain("claude");
    expect(call.argv).toContain("--bg");
    expect(call.argv).toContain("--append-system-prompt");
    expect(call.argv).toContain("watch this repo");
    expect(call.opts.cwd).toBe("/home/op/project");
  });

  test("a value containing shell metacharacters is passed through unchanged, as its own argv element", async () => {
    const weird = 'line one\nline two with $HOME and `backtick` and "quotes"';
    const commands: string[][] = [];
    await launch("/x", ["--append-system-prompt", weird], {
      runCommand: async (argv) => {
        commands.push(argv);
        return { exitCode: 0, stdout: "backgrounded · id1 (idle)\n", stderr: "" };
      },
    });
    expect(commands[0]).toContain(weird);
  });

  test("a non-zero exit from the launcher is a launch failure, with the real stderr surfaced", async () => {
    const result = await launch("/x", [], {
      runCommand: async () => ({ exitCode: 1, stdout: "", stderr: "systemd-run: command not found" }),
    });
    expect(result).toEqual({ ok: false, error: expect.stringContaining("systemd-run: command not found") });
  });

  test("a thrown launch (e.g. a timeout) is a launch failure, not an unhandled rejection", async () => {
    const result = await launch("/x", [], {
      runCommand: async () => {
        throw new Error("command timed out after 20000ms");
      },
    });
    expect(result).toEqual({ ok: false, error: expect.stringContaining("timed out") });
  });

  test("a zero exit with unparseable stdout is a launch failure, never a fabricated id", async () => {
    const result = await launch("/x", [], {
      runCommand: async () => ({ exitCode: 0, stdout: "unexpected output\n", stderr: "" }),
    });
    expect(result.ok).toBe(false);
  });

  test("each call gets a fresh, independently generated unit suffix by default", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const result = await launch("/x", [], {
        runCommand: async (argv) => {
          const unitArg = argv.find((a) => a.startsWith("--unit="));
          seen.add(unitArg ?? "");
          return { exitCode: 0, stdout: "backgrounded · id (idle)\n", stderr: "" };
        },
      });
      expect(result.ok).toBe(true);
    }
    expect(seen.size).toBe(5);
  });
});
