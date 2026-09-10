import { describe, expect, test } from "bun:test";
import { checkLiveness, decideLiveness, isPidAlive } from "../../src/spawn/liveness";
import type { BackgroundSessionInfo } from "../../src/spawn/parse";

describe("isPidAlive", () => {
  test("this process's own pid is alive", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  test("a pid essentially guaranteed not to exist is reported dead", () => {
    // PIDs are bounded (commonly by /proc/sys/kernel/pid_max); this value
    // is chosen to be implausible on any real system without hardcoding a
    // specific "known-dead" pid that could coincidentally be reused.
    expect(isPidAlive(2 ** 30)).toBe(false);
  });
});

function entry(overrides: Partial<BackgroundSessionInfo> = {}): BackgroundSessionInfo {
  return { id: "abc", sessionId: "abc-uuid", cwd: "/x", startedAt: 0, pid: undefined, state: undefined, ...overrides };
}

describe("decideLiveness", () => {
  test("no entry in the listing -> unknown, never dead", () => {
    expect(decideLiveness("abc", undefined, false)).toEqual({
      status: "unknown",
      reason: expect.stringContaining('"abc"'),
    });
  });

  test("entry listed but no pid reported -> not-verifiable, never dead", () => {
    const result = decideLiveness("abc", entry({ pid: undefined }), false);
    expect(result.status).toBe("not-verifiable");
  });

  test("entry listed with a pid that did not verify -> not-verifiable", () => {
    const result = decideLiveness("abc", entry({ pid: 42 }), false);
    expect(result.status).toBe("not-verifiable");
  });

  test("entry listed with a pid that verified alive -> alive, carrying the pid", () => {
    expect(decideLiveness("abc", entry({ pid: 42 }), true)).toEqual({ status: "alive", pid: 42 });
  });
});

describe("checkLiveness", () => {
  test("a listing that finds the session with our own (alive) pid reports alive", async () => {
    const verdict = await checkLiveness("abc", {
      runCommand: async () => ({
        exitCode: 0,
        stdout: JSON.stringify([{ id: "abc", cwd: "/x", kind: "background", startedAt: 1, sessionId: "s", pid: process.pid }]),
        stderr: "",
      }),
    });
    expect(verdict).toEqual({ status: "alive", pid: process.pid });
  });

  test("a listing that finds the session with an implausible pid reports not-verifiable", async () => {
    const verdict = await checkLiveness("abc", {
      runCommand: async () => ({
        exitCode: 0,
        stdout: JSON.stringify([{ id: "abc", cwd: "/x", kind: "background", startedAt: 1, sessionId: "s", pid: 2 ** 30 }]),
        stderr: "",
      }),
    });
    expect(verdict.status).toBe("not-verifiable");
  });

  test("a listing that does not contain the session reports unknown, not dead", async () => {
    const verdict = await checkLiveness("abc", {
      runCommand: async () => ({ exitCode: 0, stdout: "[]", stderr: "" }),
    });
    expect(verdict.status).toBe("unknown");
  });

  test("a failed listing reports unknown, not dead, and never throws", async () => {
    const verdict = await checkLiveness("abc", {
      runCommand: async () => ({ exitCode: 1, stdout: "", stderr: "not logged in" }),
    });
    expect(verdict).toEqual({ status: "unknown", reason: expect.stringContaining("not logged in") });
  });
});
