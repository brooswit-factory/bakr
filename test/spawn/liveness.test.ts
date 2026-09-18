import { describe, expect, test } from "bun:test";
import { checkLiveness, decideLiveness, isPidAlive } from "../../src/spawn/liveness";
import { makeFakeHost } from "../support/fake-host";
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
  test("no entry in the listing -> absent, never dead", () => {
    expect(decideLiveness("abc", undefined, false)).toEqual({
      status: "absent",
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
    const host = makeFakeHost();
    host.legacy.push({ id: "abc", cwd: "/x", kind: "background", startedAt: 1, sessionId: "s", pid: process.pid });
    expect(await checkLiveness("abc", { runCommand: host.runCommand })).toEqual({ status: "alive", pid: process.pid });
  });

  test("a listing that finds the session with an implausible pid reports not-verifiable", async () => {
    const host = makeFakeHost();
    host.legacy.push({ id: "abc", cwd: "/x", kind: "background", startedAt: 1, sessionId: "s", pid: 2 ** 30 });
    expect((await checkLiveness("abc", { runCommand: host.runCommand })).status).toBe("not-verifiable");
  });

  test("a listing that does not contain the session reports absent, not dead", async () => {
    expect((await checkLiveness("abc", { runCommand: makeFakeHost().runCommand })).status).toBe("absent");
  });

  test("by session id: a session restored into a new pane is still alive, whatever its old short id was", async () => {
    const host = makeFakeHost();
    host.addPane({ cwd: "/x", sessionId: "s", pid: process.pid });
    expect(await checkLiveness("old-short-id", { runCommand: host.runCommand }, "s")).toEqual({ status: "alive", pid: process.pid });
    expect((await checkLiveness("old-short-id", { runCommand: host.runCommand })).status).toBe("absent");
  });

  // BAKR-22: THIS is the test that closes the epic's incident — a listing
  // FAILURE must report its OWN verdict (`listing-failed`), DISTINCT from
  // `absent` (a listing that succeeded and simply did not find the
  // session). Before this split, both cases were folded into `unknown`,
  // and a respawn-style gate reachable on "not alive" could not tell a
  // genuinely-gone session apart from a transient CLI hiccup — killing and
  // restarting a session an operator was actively using. Falsifier: if
  // `checkLiveness` still folded these together, this test's `.status`
  // would read `absent` (or the old `unknown`), not `listing-failed`.
  test("a failed listing reports its OWN verdict, listing-failed — NEVER absent, and never throws", async () => {
    const verdict = await checkLiveness("abc", { runCommand: makeFakeHost({ failListing: true }).runCommand });
    expect(verdict).toEqual({ status: "listing-failed", reason: expect.stringContaining("listing failure") });
    expect(verdict.status).not.toBe("absent");
  });
});
