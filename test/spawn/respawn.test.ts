// BAKR-22: `claude respawn <shortId>` — the mechanism this ticket found is
// the build-independent restore (raw measurements on the ticket: 2.1.251,
// 2.1.268, and across a build change, all same id, zero forks, zero
// model-turn cost). Mirrors test/spawn/stop.test.ts's own shape.

import { describe, expect, test } from "bun:test";
import { respawnSession, isRecognizedStaleCwdRefusal } from "../../src/spawn/respawn";
import { buildRespawnInvocation } from "../../src/spawn/argv";

describe("respawnSession", () => {
  test("respawns by SHORT id alone — builds exactly `claude respawn <shortId>`, no other argv element, no flag", async () => {
    const calls: Array<{ argv: string[]; opts: { timeoutMs: number } }> = [];
    const result = await respawnSession("abc12345", {
      runCommand: async (argv, opts) => {
        calls.push({ argv, opts });
        return { exitCode: 0, stdout: "respawned abc12345\n", stderr: "" };
      },
    });
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([{ argv: ["claude", "respawn", "abc12345"], opts: { timeoutMs: 20_000 } }]);
  });

  test("THE REGRESSION TEST that pins the actual measured cause: the argv NEVER carries a permissions or model flag — this is the one thing BAKR-22 measured DOES cause a fork even where an unflagged restore correctly reattaches (isolation arm A vs B on the ticket)", async () => {
    let capturedArgv: string[] = [];
    await respawnSession("abc12345", {
      runCommand: async (argv) => {
        capturedArgv = argv;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    expect(capturedArgv).toEqual(["claude", "respawn", "abc12345"]);
    expect(capturedArgv).not.toContain("--dangerously-skip-permissions");
    expect(capturedArgv).not.toContain("--model");
    expect(capturedArgv).not.toContain("--resume");
    expect(capturedArgv).not.toContain("--fork-session");
  });

  test("never touches systemctl, a scope unit, or a cgroup path — only ever `claude respawn <id>`", async () => {
    let capturedArgv: string[] = [];
    await respawnSession("abc12345", {
      runCommand: async (argv) => {
        capturedArgv = argv;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    expect(capturedArgv[0]).toBe("claude");
    expect(capturedArgv).not.toContain("systemctl");
    expect(capturedArgv.join(" ")).not.toMatch(/scope|cgroup|kill/i);
  });

  test("a full session uuid is REJECTED by claude itself (measured: 'No job matching') — this function does not special-case it, it just surfaces the failure", async () => {
    const result = await respawnSession("54243728-0380-491c-b7f3-b48694f1cd9a", {
      runCommand: async () => ({ exitCode: 1, stdout: "No job matching '54243728-0380-491c-b7f3-b48694f1cd9a'.\n", stderr: "" }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("No job matching");
  });

  test("the recognised stale-cwd refusal surfaces as an ordinary failure — the caller, not this function, decides to escalate to forkFrom", async () => {
    const result = await respawnSession("abc12345", {
      runCommand: async () => ({
        exitCode: 1,
        stdout: "Couldn't start a background session (working directory no longer exists or is not accessible: /tmp/moved-away)\n",
        stderr: "",
      }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(isRecognizedStaleCwdRefusal(result.error)).toBe(true);
  });

  test("an unrecognised failure (unknown job, ambiguous prefix, anything else) is NOT the recognised stale-cwd shape — this is the predicate that keeps 'fork on a guess' from ever happening", async () => {
    const unknown = await respawnSession("deadbeef", { runCommand: async () => ({ exitCode: 1, stdout: "No job matching 'deadbeef'.\n", stderr: "" }) });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(isRecognizedStaleCwdRefusal(unknown.error)).toBe(false);

    const ambiguous = await respawnSession("ab", { runCommand: async () => ({ exitCode: 1, stdout: "Ambiguous short id 'ab' matches more than one job.\n", stderr: "" }) });
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) expect(isRecognizedStaleCwdRefusal(ambiguous.error)).toBe(false);
  });

  test("a thrown respawn (e.g. a timeout) is a respawn failure, not an unhandled rejection", async () => {
    const result = await respawnSession("abc12345", {
      runCommand: async () => {
        throw new Error("command timed out after 20000ms");
      },
    });
    expect(result).toEqual({ ok: false, error: expect.stringContaining("timed out") });
  });
});

describe("buildRespawnInvocation (argv-exactness)", () => {
  test("exactly claude respawn <shortId>, nothing else, ever", () => {
    expect(buildRespawnInvocation("abc12345")).toEqual({ argv: ["claude", "respawn", "abc12345"], timeoutMs: 20_000 });
  });

  test("an id containing shell-metacharacter-looking text still travels as ONE argv element (argv-array invocation throughout, per this substrate's own convention — never a shell string)", () => {
    const weird = "abc$( echo hi )";
    expect(buildRespawnInvocation(weird).argv).toEqual(["claude", "respawn", weird]);
  });
});
