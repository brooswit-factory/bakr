import { describe, expect, test } from "bun:test";
import {
  beginLaunch,
  claimedKeysWithSlots,
  emptySessionSlots,
  hasLaunchRecordFor,
  markLaunchFailed,
  markLaunchStarted,
  parseSessionSlotsState,
  pendingLaunches,
  resolveLaunch,
  serializeSessionSlotsState,
  sessionsOn,
  unresolvedLaunches,
  type SessionSlotsState,
} from "../../src/session-slots";
import type { ClaimKey } from "../../src/claim-key-resolve";

const KEY_A = "/home/alice/project" as ClaimKey;
const KEY_B = "/home/alice/other" as ClaimKey;

describe("sessionsOn / claimedKeysWithSlots", () => {
  test("an empty store has no sessions on and no keys", () => {
    const state = emptySessionSlots();
    expect(sessionsOn(state, KEY_A)).toEqual([]);
    expect(claimedKeysWithSlots(state)).toEqual([]);
  });
});

describe("fresh-launch lifecycle: begin -> started -> resolve", () => {
  test("a fresh launch (no priorSessionId) adds the resolved session id to onByKey", () => {
    let state = emptySessionSlots();
    state = beginLaunch(state, KEY_A, undefined, "attempt-1", 1000);
    expect(pendingLaunches(state)).toHaveLength(1);
    expect(sessionsOn(state, KEY_A)).toEqual([]);

    state = markLaunchStarted(state, "attempt-1", "short-1");
    expect(pendingLaunches(state)[0]?.launchShortId).toBe("short-1");

    state = resolveLaunch(state, "short-1", "session-uuid-1");
    expect(sessionsOn(state, KEY_A)).toEqual(["session-uuid-1"]);
    expect(pendingLaunches(state)).toEqual([]);
    expect(claimedKeysWithSlots(state)).toEqual([KEY_A]);
  });

  test("resolving an unknown short id is a no-op, not an error", () => {
    const state = emptySessionSlots();
    expect(() => resolveLaunch(state, "no-such-short-id", "session-uuid")).not.toThrow();
    expect(resolveLaunch(state, "no-such-short-id", "session-uuid")).toEqual(state);
  });
});

describe("restore/rotation lifecycle: the resolved id REPLACES the prior one", () => {
  test("resolving a restore replaces priorSessionId with the new session id, never appends alongside it", () => {
    let state = emptySessionSlots();
    state = beginLaunch(state, KEY_A, undefined, "attempt-1", 1000);
    state = markLaunchStarted(state, "attempt-1", "short-1");
    state = resolveLaunch(state, "short-1", "session-uuid-OLD");
    expect(sessionsOn(state, KEY_A)).toEqual(["session-uuid-OLD"]);

    state = beginLaunch(state, KEY_A, "session-uuid-OLD", "attempt-2", 2000);
    state = markLaunchStarted(state, "attempt-2", "short-2");
    state = resolveLaunch(state, "short-2", "session-uuid-NEW");

    expect(sessionsOn(state, KEY_A)).toEqual(["session-uuid-NEW"]);
    expect(sessionsOn(state, KEY_A)).not.toContain("session-uuid-OLD");
  });

  test("a restore whose priorSessionId is not (or no longer) present in onByKey still adds the new id rather than dropping it", () => {
    let state = emptySessionSlots();
    state = beginLaunch(state, KEY_A, "session-uuid-STALE", "attempt-1", 1000);
    state = markLaunchStarted(state, "attempt-1", "short-1");
    state = resolveLaunch(state, "short-1", "session-uuid-NEW");
    expect(sessionsOn(state, KEY_A)).toEqual(["session-uuid-NEW"]);
  });
});

describe("failed launches: permanently unresolved, never auto-cleared", () => {
  test("markLaunchFailed moves a record out of pendingLaunches and into unresolvedLaunches", () => {
    let state = emptySessionSlots();
    state = beginLaunch(state, KEY_A, undefined, "attempt-1", 1000);
    expect(pendingLaunches(state)).toHaveLength(1);
    expect(unresolvedLaunches(state)).toHaveLength(0);

    state = markLaunchFailed(state, "attempt-1", "launch exited 1: boom");

    expect(pendingLaunches(state)).toHaveLength(0);
    expect(unresolvedLaunches(state)).toHaveLength(1);
    expect(unresolvedLaunches(state)[0]?.error).toBe("launch exited 1: boom");
    expect(sessionsOn(state, KEY_A)).toEqual([]);
  });

  test("a failed launch is never touched by resolveLaunch even if its short id later appears", () => {
    let state = emptySessionSlots();
    state = beginLaunch(state, KEY_A, undefined, "attempt-1", 1000);
    state = markLaunchStarted(state, "attempt-1", "short-1");
    state = markLaunchFailed(state, "attempt-1", "wrapper timed out after detach");

    // Nothing in this module ever adopts an unresolved launch by matching a
    // later listing — it stays unresolved regardless of what a future
    // listing shows (BAKR-12 Constraint 2: never resolved by cwd, never
    // auto-retried).
    const before = state;
    state = resolveLaunch(state, "short-1", "session-uuid-1");
    expect(state).toEqual(before);
    expect(unresolvedLaunches(state)).toHaveLength(1);
  });
});

describe("hasLaunchRecordFor: the duplicate-restore guard", () => {
  test("false when there is no launch record for that (key, priorSessionId) pair", () => {
    expect(hasLaunchRecordFor(emptySessionSlots(), KEY_A, "session-x")).toBe(false);
  });

  test("true while a launch is pending resolution", () => {
    let state = emptySessionSlots();
    state = beginLaunch(state, KEY_A, "session-x", "attempt-1", 1000);
    expect(hasLaunchRecordFor(state, KEY_A, "session-x")).toBe(true);
  });

  test("true after a launch permanently fails — never auto-retried", () => {
    let state = emptySessionSlots();
    state = beginLaunch(state, KEY_A, "session-x", "attempt-1", 1000);
    state = markLaunchFailed(state, "attempt-1", "boom");
    expect(hasLaunchRecordFor(state, KEY_A, "session-x")).toBe(true);
  });

  test("false again once the launch resolves — the record is removed by resolveLaunch", () => {
    let state = emptySessionSlots();
    state = beginLaunch(state, KEY_A, "session-x", "attempt-1", 1000);
    state = markLaunchStarted(state, "attempt-1", "short-1");
    state = resolveLaunch(state, "short-1", "session-y");
    expect(hasLaunchRecordFor(state, KEY_A, "session-x")).toBe(false);
  });

  test("does not match a different key or a different priorSessionId", () => {
    let state = emptySessionSlots();
    state = beginLaunch(state, KEY_A, "session-x", "attempt-1", 1000);
    expect(hasLaunchRecordFor(state, KEY_B, "session-x")).toBe(false);
    expect(hasLaunchRecordFor(state, KEY_A, "session-other")).toBe(false);
  });
});

describe("independence across directories", () => {
  test("launches and slots for one key never affect another", () => {
    let state = emptySessionSlots();
    state = beginLaunch(state, KEY_A, undefined, "attempt-a", 1000);
    state = markLaunchStarted(state, "attempt-a", "short-a");
    state = resolveLaunch(state, "short-a", "session-a");

    state = beginLaunch(state, KEY_B, undefined, "attempt-b", 1000);
    state = markLaunchStarted(state, "attempt-b", "short-b");
    state = resolveLaunch(state, "short-b", "session-b");

    expect(sessionsOn(state, KEY_A)).toEqual(["session-a"]);
    expect(sessionsOn(state, KEY_B)).toEqual(["session-b"]);
    expect([...claimedKeysWithSlots(state)].sort()).toEqual([KEY_A, KEY_B].sort());
  });
});

describe("wire format round-trip", () => {
  function expectRoundTrips(state: SessionSlotsState): void {
    const parsed = parseSessionSlotsState(serializeSessionSlotsState(state));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.state).toEqual(state);
    }
  }

  test("an empty store round-trips", () => {
    expectRoundTrips(emptySessionSlots());
  });

  test("a store with on-sessions and pending/unresolved launches round-trips", () => {
    let state = emptySessionSlots();
    state = beginLaunch(state, KEY_A, undefined, "attempt-1", 1000);
    state = markLaunchStarted(state, "attempt-1", "short-1");
    state = resolveLaunch(state, "short-1", "session-uuid-1");
    state = beginLaunch(state, KEY_B, "session-uuid-old", "attempt-2", 2000);
    state = markLaunchFailed(state, "attempt-2", "boom");
    state = beginLaunch(state, KEY_A, undefined, "attempt-3", 3000);
    expectRoundTrips(state);
  });

  test("invalid JSON is reported as a typed error, never thrown", () => {
    const result = parseSessionSlotsState("{not json");
    expect(result.ok).toBe(false);
  });

  test("valid JSON with the wrong shape is reported as a typed error", () => {
    const result = parseSessionSlotsState(JSON.stringify({ hello: "world" }));
    expect(result.ok).toBe(false);
  });

  test("a wrong version number is reported as a typed error", () => {
    const result = parseSessionSlotsState(JSON.stringify({ version: 2, onByKey: {}, launches: [] }));
    expect(result.ok).toBe(false);
  });

  test("a malformed launch record is reported as a typed error", () => {
    const result = parseSessionSlotsState(JSON.stringify({ version: 1, onByKey: {}, launches: [{ attemptId: 5 }] }));
    expect(result.ok).toBe(false);
  });

  test("a malformed onByKey entry is reported as a typed error", () => {
    const result = parseSessionSlotsState(JSON.stringify({ version: 1, onByKey: { "/x": [1, 2] }, launches: [] }));
    expect(result.ok).toBe(false);
  });
});
