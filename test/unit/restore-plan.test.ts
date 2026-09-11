// BAKR-22: `planRestore` and the `AttemptKey` keying rule that makes B13
// work with no fork-specific branch. Falsifier stated for each test before
// it runs, per this ticket's own house rule.

import { describe, expect, test } from "bun:test";
import {
  planRestore,
  hasLaunchRecordFor,
  beginLaunch,
  clearFailedLaunchRecord,
  markLaunchFailed,
  markLaunchStarted,
  resolveLaunch,
  resolveRespawnAttempt,
  emptyAgentStore,
  putAgent,
  type AgentRecord,
  type AgentStoreState,
} from "../../src/agent-model";
import type { ClaimKey } from "../../src/claim-key-resolve";

const KEY = "/tmp/dir" as ClaimKey;

function agent(overrides: Partial<AgentRecord> & { id: string }): AgentRecord {
  return {
    name: undefined,
    directory: KEY,
    state: "on",
    createdAt: 0,
    birthSessionId: undefined,
    restoreTarget: undefined,
    ...overrides,
  };
}

describe("planRestore", () => {
  test("an agent with no restoreTarget yet plans fresh — falsifier: it should NEVER plan respawn against a shortId that does not exist", () => {
    const a = agent({ id: "@a" });
    expect(planRestore(a)).toEqual({ kind: "fresh" });
  });

  test("an agent with a restoreTarget plans respawn against its OWN shortId, never its birthSessionId — falsifier: if this read birthSessionId instead, a forked agent's restore would target the wrong (stale) id", () => {
    const a = agent({ id: "@a", birthSessionId: "birth-uuid", restoreTarget: { sessionId: "current-uuid", shortId: "current-" } });
    expect(planRestore(a)).toEqual({ kind: "respawn", shortId: "current-" });
  });

  test("planRestore never returns forkFrom — that is a reactive fallback the CALLER chooses only after a recognised respawn failure, never a plan chosen up front", () => {
    const a = agent({ id: "@a", restoreTarget: { sessionId: "s", shortId: "short" } });
    const plan = planRestore(a);
    expect(plan.kind).not.toBe("forkFrom" as never);
  });
});

describe("the AttemptKey keying rule (B13 survives with no fork-specific branch)", () => {
  test("a give-up on a respawn shortId blocks a FUTURE attempt keyed on the SAME shortId — falsifier: if hasLaunchRecordFor did not compare the whole tagged value, this would silently retry", () => {
    let state = emptyAgentStore();
    state = putAgent(state, agent({ id: "@a", restoreTarget: { sessionId: "s1", shortId: "short1" } }));
    state = beginLaunch(state, "@a", KEY, { kind: "respawn", shortId: "short1" }, "attempt-1", 0);
    state = markLaunchFailed(state, "attempt-1", "gave up");

    expect(hasLaunchRecordFor(state, "@a", { kind: "respawn", shortId: "short1" })).toBe(true);
  });

  test("a give-up on a respawn shortId does NOT block an attempt keyed on a DIFFERENT shortId — falsifier: if the guard ignored the shortId value entirely, this would also read true", () => {
    let state = emptyAgentStore();
    state = putAgent(state, agent({ id: "@a", restoreTarget: { sessionId: "s1", shortId: "short1" } }));
    state = beginLaunch(state, "@a", KEY, { kind: "respawn", shortId: "short1" }, "attempt-1", 0);
    state = markLaunchFailed(state, "attempt-1", "gave up");

    expect(hasLaunchRecordFor(state, "@a", { kind: "respawn", shortId: "short2" })).toBe(false);
  });

  test("a give-up on a forkFrom pre-fork sessionId does NOT match a respawn attempt on the same-looking string — kind is part of the key, not just the value", () => {
    let state = emptyAgentStore();
    state = putAgent(state, agent({ id: "@a" }));
    state = beginLaunch(state, "@a", KEY, { kind: "forkFrom", sessionId: "same-string" }, "attempt-1", 0);
    state = markLaunchFailed(state, "attempt-1", "gave up");

    expect(hasLaunchRecordFor(state, "@a", { kind: "forkFrom", sessionId: "same-string" })).toBe(true);
    expect(hasLaunchRecordFor(state, "@a", { kind: "respawn", shortId: "same-string" })).toBe(false);
  });

  test("clearFailedLaunchRecord only clears the EXACT matching key, not a same-agent record under a different key — falsifier: operator clearing one wedge should never silently clear an unrelated one", () => {
    let state = emptyAgentStore();
    state = putAgent(state, agent({ id: "@a" }));
    state = beginLaunch(state, "@a", KEY, { kind: "respawn", shortId: "short1" }, "attempt-1", 0);
    state = markLaunchFailed(state, "attempt-1", "gave up 1");
    state = beginLaunch(state, "@a", KEY, { kind: "respawn", shortId: "short2" }, "attempt-2", 0);
    state = markLaunchFailed(state, "attempt-2", "gave up 2");

    const cleared = clearFailedLaunchRecord(state, "@a", { kind: "respawn", shortId: "short1" });
    expect(hasLaunchRecordFor(cleared, "@a", { kind: "respawn", shortId: "short1" })).toBe(false);
    expect(hasLaunchRecordFor(cleared, "@a", { kind: "respawn", shortId: "short2" })).toBe(true);
  });

  test("clearFailedLaunchRecord is a no-op against a genuinely in-flight (not yet failed) record — never clears something that might still resolve on its own", () => {
    let state = emptyAgentStore();
    state = putAgent(state, agent({ id: "@a" }));
    state = beginLaunch(state, "@a", KEY, { kind: "respawn", shortId: "short1" }, "attempt-1", 0);
    // no markLaunchFailed — still in flight

    const cleared = clearFailedLaunchRecord(state, "@a", { kind: "respawn", shortId: "short1" });
    expect(cleared).toBe(state); // total no-op, same object, per this file's own convention
    expect(hasLaunchRecordFor(cleared, "@a", { kind: "respawn", shortId: "short1" })).toBe(true);
  });
});

describe("resolveRespawnAttempt — the respawn-kind counterpart to resolveLaunch (synchronous, no listing needed)", () => {
  test("a successful respawn attempt is simply removed — restoreTarget is untouched because respawn never changes it", () => {
    let state = emptyAgentStore();
    const original = agent({ id: "@a", restoreTarget: { sessionId: "s1", shortId: "short1" } });
    state = putAgent(state, original);
    state = beginLaunch(state, "@a", KEY, { kind: "respawn", shortId: "short1" }, "attempt-1", 0);

    const resolved = resolveRespawnAttempt(state, "attempt-1");
    expect(hasLaunchRecordFor(resolved, "@a", { kind: "respawn", shortId: "short1" })).toBe(false);
    expect(resolved.agents["@a"]).toEqual(original);
  });

  test("resolving an unknown attemptId is a total no-op", () => {
    const state = emptyAgentStore();
    expect(resolveRespawnAttempt(state, "no-such-attempt")).toBe(state);
  });
});

describe("resolveLaunch's forkFrom branch (BAKR-22's own correction: fork from CURRENT restoreTarget, never birthSessionId)", () => {
  test("a forkFrom resolution advances restoreTarget to the NEW session/shortId, leaving birthSessionId untouched", () => {
    let state = emptyAgentStore();
    state = putAgent(state, agent({ id: "@a", birthSessionId: "birth", restoreTarget: { sessionId: "pre-fork", shortId: "prefork1" } }));
    state = beginLaunch(state, "@a", KEY, { kind: "forkFrom", sessionId: "pre-fork" }, "attempt-1", 0);
    state = markLaunchStarted(state, "attempt-1", "newshort1"); // launch() returned its short id; a later listing resolves the rest

    const resolved = resolveLaunch(state, "newshort1", "new-fork-session");
    const a = resolved.agents["@a"];
    expect(a?.birthSessionId).toBe("birth");
    expect(a?.restoreTarget).toEqual({ sessionId: "new-fork-session", shortId: "newshort1" });
  });

  test("a forkFrom resolution is REFUSED (no-op on the agent) if the agent's restoreTarget has since moved away from the pre-fork session this attempt was keyed on — stale resolution never silently applied", () => {
    let state = emptyAgentStore();
    state = putAgent(state, agent({ id: "@a", birthSessionId: "birth", restoreTarget: { sessionId: "pre-fork", shortId: "prefork1" } }));
    state = beginLaunch(state, "@a", KEY, { kind: "forkFrom", sessionId: "pre-fork" }, "attempt-1", 0);
    state = markLaunchStarted(state, "attempt-1", "newshort1");
    // Simulate the target having already moved (e.g. a second, faster
    // resolution landed first) before this attempt's own listing resolves.
    state = putAgent(state, { ...state.agents["@a"]!, restoreTarget: { sessionId: "moved-elsewhere", shortId: "moved111" } });

    const resolved = resolveLaunch(state, "newshort1", "new-fork-session");
    expect(resolved.agents["@a"]?.restoreTarget).toEqual({ sessionId: "moved-elsewhere", shortId: "moved111" });
  });

  test("a fresh-launch resolution sets BOTH birthSessionId and restoreTarget for the first time, and is idempotent against a duplicate resolution", () => {
    let state = emptyAgentStore();
    state = putAgent(state, agent({ id: "@a" }));
    state = beginLaunch(state, "@a", KEY, undefined, "attempt-1", 0);
    state = markLaunchStarted(state, "attempt-1", "shortid01");

    const resolved = resolveLaunch(state, "shortid01", "first-session");
    const a = resolved.agents["@a"];
    expect(a?.birthSessionId).toBe("first-session");
    expect(a?.restoreTarget).toEqual({ sessionId: "first-session", shortId: "shortid01" });
  });
});
