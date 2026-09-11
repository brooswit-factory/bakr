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
  promoteUnresolvableLaunches,
  recordRestoreAttempt,
  resetRestoreAttempts,
  restoreAttemptCount,
  resolveLaunch,
  serializeSessionSlotsState,
  sessionsOn,
  slotsOn,
  unresolvedLaunches,
  type SessionSlotsState,
} from "../../src/session-slots";
import type { ClaimKey } from "../../src/claim-key-resolve";

const KEY_A = "/home/alice/project" as ClaimKey;
const KEY_B = "/home/alice/other" as ClaimKey;
const SESSION_A = "durable-session-a";
const SESSION_B = "durable-session-b";

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

describe("restore/rotation lifecycle: the DURABLE id never moves; only liveSessionId updates (fixed after live review — see session-slots.ts's own module comment)", () => {
  test("resolving a restore updates liveSessionId only — durableSessionId (what --resume takes) is UNCHANGED", () => {
    let state = emptySessionSlots();
    state = beginLaunch(state, KEY_A, undefined, "attempt-1", 1000);
    state = markLaunchStarted(state, "attempt-1", "short-1");
    state = resolveLaunch(state, "short-1", "session-uuid-DURABLE");
    expect(sessionsOn(state, KEY_A)).toEqual(["session-uuid-DURABLE"]);
    expect(slotsOn(state, KEY_A)).toEqual([{ durableSessionId: "session-uuid-DURABLE", liveSessionId: "session-uuid-DURABLE" }]);

    // A restore resumes the durable id and the listing reveals a ROTATED live id.
    state = beginLaunch(state, KEY_A, "session-uuid-DURABLE", "attempt-2", 2000);
    state = markLaunchStarted(state, "attempt-2", "short-2");
    state = resolveLaunch(state, "short-2", "session-uuid-ROTATED");

    // sessionsOn (durable ids) is untouched — this is the actual fix.
    expect(sessionsOn(state, KEY_A)).toEqual(["session-uuid-DURABLE"]);
    // But the live id used for liveness checks did update.
    expect(slotsOn(state, KEY_A)).toEqual([{ durableSessionId: "session-uuid-DURABLE", liveSessionId: "session-uuid-ROTATED" }]);
  });

  test("a restore whose priorSessionId no longer matches any existing slot still records something rather than silently dropping it (defensive fallback, not an expected path)", () => {
    let state = emptySessionSlots();
    state = beginLaunch(state, KEY_A, "session-uuid-STALE", "attempt-1", 1000);
    state = markLaunchStarted(state, "attempt-1", "short-1");
    state = resolveLaunch(state, "short-1", "session-uuid-NEW");
    // No slot with durableSessionId "session-uuid-STALE" existed beforehand — the fallback creates one rather than losing the update.
    expect(slotsOn(state, KEY_A)).toEqual([{ durableSessionId: "session-uuid-STALE", liveSessionId: "session-uuid-NEW" }]);
  });

  test("resuming the SAME durable id repeatedly (multiple restore sagas) never creates a second slot", () => {
    let state = emptySessionSlots();
    state = beginLaunch(state, KEY_A, undefined, "attempt-1", 1000);
    state = markLaunchStarted(state, "attempt-1", "short-1");
    state = resolveLaunch(state, "short-1", "durable-1");

    for (let i = 2; i <= 4; i++) {
      state = beginLaunch(state, KEY_A, "durable-1", `attempt-${i}`, 1000 * i);
      state = markLaunchStarted(state, `attempt-${i}`, `short-${i}`);
      state = resolveLaunch(state, `short-${i}`, `rotated-${i}`);
    }

    expect(sessionsOn(state, KEY_A)).toEqual(["durable-1"]); // still exactly one slot
    expect(slotsOn(state, KEY_A)).toEqual([{ durableSessionId: "durable-1", liveSessionId: "rotated-4" }]); // live id reflects the latest rotation
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

describe("promoteUnresolvableLaunches: closes the crash-mid-launch wedge (review fix, PR #7)", () => {
  test("a record with no launchShortId and no error is promoted to unresolved", () => {
    let state = emptySessionSlots();
    state = beginLaunch(state, KEY_A, "prior-id", "attempt-1", 1000);
    expect(pendingLaunches(state)).toHaveLength(1);
    expect(unresolvedLaunches(state)).toHaveLength(0);

    state = promoteUnresolvableLaunches(state, "crashed mid-launch");

    expect(pendingLaunches(state)).toHaveLength(0);
    expect(unresolvedLaunches(state)).toHaveLength(1);
    expect(unresolvedLaunches(state)[0]?.error).toBe("crashed mid-launch");
    // The stale prior id is untouched — a promoted record behaves exactly like any other permanently-failed launch.
    expect(sessionsOn(state, KEY_A)).toEqual([]);
  });

  test("does not touch a record that already has a launchShortId (genuinely in flight, not wedged)", () => {
    let state = emptySessionSlots();
    state = beginLaunch(state, KEY_A, undefined, "attempt-1", 1000);
    state = markLaunchStarted(state, "attempt-1", "short-1");

    const before = state;
    state = promoteUnresolvableLaunches(state, "crashed mid-launch");

    expect(state).toEqual(before);
    expect(pendingLaunches(state)).toHaveLength(1);
    expect(unresolvedLaunches(state)).toHaveLength(0);
  });

  test("does not touch a record that already has an error (already permanently unresolved)", () => {
    let state = emptySessionSlots();
    state = beginLaunch(state, KEY_A, undefined, "attempt-1", 1000);
    state = markLaunchFailed(state, "attempt-1", "original failure reason");

    state = promoteUnresolvableLaunches(state, "crashed mid-launch");

    expect(unresolvedLaunches(state)[0]?.error).toBe("original failure reason"); // not overwritten
  });

  test("a no-op when there is nothing to promote", () => {
    const state = emptySessionSlots();
    expect(promoteUnresolvableLaunches(state, "crashed mid-launch")).toEqual(state);
  });

  test("promotes multiple wedged records independently, leaves unrelated records alone", () => {
    let state = emptySessionSlots();
    state = beginLaunch(state, KEY_A, undefined, "wedged-1", 1000); // wedged: no shortId, no error
    state = beginLaunch(state, KEY_B, undefined, "wedged-2", 1000); // wedged too
    state = beginLaunch(state, KEY_A, undefined, "in-flight", 2000);
    state = markLaunchStarted(state, "in-flight", "short-x"); // genuinely in flight, must survive

    state = promoteUnresolvableLaunches(state, "crashed mid-launch");

    expect(unresolvedLaunches(state)).toHaveLength(2);
    expect(pendingLaunches(state)).toHaveLength(1);
    expect(pendingLaunches(state)[0]?.attemptId).toBe("in-flight");
  });

  test("once promoted, a wedged record's session is no longer blocked from restore by hasLaunchRecordFor once it's gone through the full unresolved lifecycle — but the guard still holds while it's the current record for that (key, priorSessionId)", () => {
    // This documents the actual current behaviour: promotion does NOT clear
    // hasLaunchRecordFor for the (key, priorSessionId) pair — it converts
    // the record from silently-blocking to loudly-blocking (Constraint 2's
    // "never retried automatically"), which is the whole point: the fix is
    // about VISIBILITY, not about resuming the retry.
    let state = emptySessionSlots();
    state = beginLaunch(state, KEY_A, "prior-id", "wedged-1", 1000);
    expect(hasLaunchRecordFor(state, KEY_A, "prior-id")).toBe(true);

    state = promoteUnresolvableLaunches(state, "crashed mid-launch");

    expect(hasLaunchRecordFor(state, KEY_A, "prior-id")).toBe(true);
    expect(unresolvedLaunches(state)).toHaveLength(1);
  });
});

describe("restoreAttemptCount / recordRestoreAttempt / resetRestoreAttempts: the bounded-retry mechanism, keyed by DURABLE SESSION ID (BAKR-13 defect 1 — was keyed by claimed directory)", () => {
  test("a fresh store has zero attempts recorded for any session id", () => {
    expect(restoreAttemptCount(emptySessionSlots(), SESSION_A)).toBe(0);
  });

  test("recordRestoreAttempt increments, independently per session id", () => {
    let state = emptySessionSlots();
    state = recordRestoreAttempt(state, SESSION_A);
    state = recordRestoreAttempt(state, SESSION_A);
    state = recordRestoreAttempt(state, SESSION_B);
    expect(restoreAttemptCount(state, SESSION_A)).toBe(2);
    expect(restoreAttemptCount(state, SESSION_B)).toBe(1);
  });

  test("resetRestoreAttempts brings a session id back to zero and is a true no-op (identical object) when already zero", () => {
    let state = emptySessionSlots();
    state = recordRestoreAttempt(state, SESSION_A);
    state = resetRestoreAttempts(state, SESSION_A);
    expect(restoreAttemptCount(state, SESSION_A)).toBe(0);

    const before = state;
    state = resetRestoreAttempts(state, SESSION_A);
    expect(state).toBe(before);
  });

  test("resetRestoreAttempts for one session id never touches another's count — this is what stops an alive sibling slot from defeating a failing slot's bound (BAKR-13 defect 1)", () => {
    let state = emptySessionSlots();
    state = recordRestoreAttempt(state, SESSION_A);
    state = recordRestoreAttempt(state, SESSION_A);
    state = recordRestoreAttempt(state, SESSION_B);
    state = resetRestoreAttempts(state, SESSION_A); // e.g. SESSION_A's slot just verified alive
    expect(restoreAttemptCount(state, SESSION_A)).toBe(0);
    expect(restoreAttemptCount(state, SESSION_B)).toBe(1); // SESSION_B's own count is untouched
  });

  test("beginLaunch with priorSessionId undefined (a FRESH launch, never the daemon's own restore path) does not touch restoreAttemptCounts at all — keyed by durable session id now, and a fresh launch has no durable id yet to key by, so it starts at zero by construction (BAKR-13 defect 1: the old directory-keyed reset here would have wiped a FAILING SIBLING slot's count)", () => {
    let state = emptySessionSlots();
    state = recordRestoreAttempt(state, SESSION_A);
    state = recordRestoreAttempt(state, SESSION_A);
    expect(restoreAttemptCount(state, SESSION_A)).toBe(2);

    state = beginLaunch(state, KEY_A, undefined, "fresh-attempt", 1000);
    // Unrelated entries are untouched by a fresh launch into the same (or any) directory.
    expect(restoreAttemptCount(state, SESSION_A)).toBe(2);
  });

  test("beginLaunch with a priorSessionId DEFINED (the daemon's own restore path) does NOT reset the count — that would defeat the bound", () => {
    let state = emptySessionSlots();
    state = recordRestoreAttempt(state, SESSION_A);
    state = beginLaunch(state, KEY_A, SESSION_A, "restore-attempt", 1000);
    expect(restoreAttemptCount(state, SESSION_A)).toBe(1);
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

  describe("restoreAttemptCounts is OPTIONAL in the persisted shape (review, PR #8 round 2: backward compat with the store PR #7 already shipped)", () => {
    test("a store with no restoreAttemptCounts field at all (the exact shape the pre-fix version serialized) parses successfully, defaulting to {}", () => {
      const result = parseSessionSlotsState(JSON.stringify({ version: 1, onByKey: {}, launches: [] }));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(restoreAttemptCount(result.state, KEY_A)).toBe(0);
      }
    });

    test("a store with on-sessions but no restoreAttemptCounts field still parses, and the count for any key defaults to zero (not an error)", () => {
      const result = parseSessionSlotsState(JSON.stringify({ version: 1, onByKey: { [KEY_A]: ["session-1"] }, launches: [] }));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(sessionsOn(result.state, KEY_A)).toEqual(["session-1"]);
        expect(restoreAttemptCount(result.state, KEY_A)).toBe(0);
      }
    });

    test("a PRESENT but invalid restoreAttemptCounts is still rejected as malformed — this is a default for ABSENCE, not a loosened shape check", () => {
      const result = parseSessionSlotsState(JSON.stringify({ version: 1, onByKey: {}, launches: [], restoreAttemptCounts: { [KEY_A]: "not-a-number" } }));
      expect(result.ok).toBe(false);
    });

    test("a present and valid restoreAttemptCounts round-trips normally", () => {
      let state = emptySessionSlots();
      state = recordRestoreAttempt(state, KEY_A);
      state = recordRestoreAttempt(state, KEY_A);
      expectRoundTrips(state);
    });
  });

  describe("onByKey accepts the LEGACY pre-durable/live-split shape (bare id strings) proactively — applying the same lesson learned above before another live incident forces it", () => {
    test("a legacy bare-string on-set entry (written by every build up to and including PR #8) parses, normalized to durableSessionId === liveSessionId === that string", () => {
      const result = parseSessionSlotsState(JSON.stringify({ version: 1, onByKey: { [KEY_A]: ["legacy-session-id"] }, launches: [] }));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(sessionsOn(result.state, KEY_A)).toEqual(["legacy-session-id"]);
        expect(slotsOn(result.state, KEY_A)).toEqual([{ durableSessionId: "legacy-session-id", liveSessionId: "legacy-session-id" }]);
      }
    });

    test("the current shape ({durableSessionId, liveSessionId}) parses directly, without normalization changing it", () => {
      const result = parseSessionSlotsState(
        JSON.stringify({ version: 1, onByKey: { [KEY_A]: [{ durableSessionId: "d1", liveSessionId: "l1" }] }, launches: [] })
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(slotsOn(result.state, KEY_A)).toEqual([{ durableSessionId: "d1", liveSessionId: "l1" }]);
      }
    });

    test("legacy and current shapes can coexist in the same onByKey array (e.g. a store written partly by an old build, partly by this one)", () => {
      const result = parseSessionSlotsState(
        JSON.stringify({ version: 1, onByKey: { [KEY_A]: ["legacy-id", { durableSessionId: "d2", liveSessionId: "l2" }] }, launches: [] })
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(slotsOn(result.state, KEY_A)).toEqual([
          { durableSessionId: "legacy-id", liveSessionId: "legacy-id" },
          { durableSessionId: "d2", liveSessionId: "l2" },
        ]);
      }
    });

    test("an on-set entry that is neither a string nor a valid {durableSessionId, liveSessionId} object is still rejected as malformed", () => {
      const result = parseSessionSlotsState(JSON.stringify({ version: 1, onByKey: { [KEY_A]: [{ durableSessionId: "d1" }] }, launches: [] }));
      expect(result.ok).toBe(false);
    });

    test("serializeSessionSlotsState always writes the CURRENT shape, never the legacy one, even for a slot originally read from a legacy entry", () => {
      const result = parseSessionSlotsState(JSON.stringify({ version: 1, onByKey: { [KEY_A]: ["legacy-id"] }, launches: [] }));
      expect(result.ok).toBe(true);
      if (result.ok) {
        const serialized = JSON.parse(serializeSessionSlotsState(result.state));
        expect(serialized.onByKey[KEY_A]).toEqual([{ durableSessionId: "legacy-id", liveSessionId: "legacy-id" }]);
      }
    });
  });
});
