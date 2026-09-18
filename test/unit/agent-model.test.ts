import { describe, expect, test } from "bun:test";
import {
  AGENT_ID_BODY_LENGTH,
  RESERVED_NAMES,
  type AgentRecord,
  agentsInDirectory,
  beginLaunch,
  checkNameAvailability,
  emptyAgentStore,
  hasLaunchRecordFor,
  isIdTakenOrRetired,
  markLaunchFailed,
  markLaunchStarted,
  mintAgentId,
  mintUniqueAgentId,
  parseAgentStoreState,
  pendingLaunches,
  promoteUnresolvableLaunches,
  putAgent,
  recordRestoreAttempt,
  resetRestoreAttempts,
  resolveAgent,
  resolveLaunch,
  resolveRespawnAttempt,
  restoreAttemptCount,
  serializeAgentStoreState,
  unresolvedLaunches,
  validateNameSyntax,
  type AgentStoreState,
} from "../../src/agent-model";
import type { ClaimKey } from "../../src/claim-key-resolve";

const DIR_A = "/home/alice/project" as ClaimKey;
const DIR_B = "/home/alice/other" as ClaimKey;

function makeAgent(overrides: Partial<AgentRecord> & { id: string }): AgentRecord {
  return {
    name: undefined,
    directory: DIR_A,
    state: "on",
    createdAt: 1000,
    birthSessionId: undefined,
    restoreTarget: undefined,
    ...overrides,
  };
}

// --- Id minting (B3, AC5) -------------------------------------------------

describe("mintAgentId: '@' + 18 lowercase Crockford base32 characters (B3)", () => {
  test("shape: '@' prefix, exactly 18 lowercase base32 characters, never i/l/o/u", () => {
    const id = mintAgentId((n) => new Uint8Array(n).fill(0xff));
    expect(id).toMatch(/^@[0-9a-z]{18}$/);
    expect(id.length).toBe(1 + AGENT_ID_BODY_LENGTH);
    for (const forbidden of ["i", "l", "o", "u"]) {
      expect(id.includes(forbidden)).toBe(false);
    }
  });

  test("falsifier guard: an uppercase-alphabet regex would wrongly reject a real (lowercase) id — assert lowercase specifically, not case-insensitively", () => {
    const id = mintAgentId((n) => new Uint8Array(n).fill(0xff)); // all-1 bits -> every 5-bit group is 31 -> letter 'z', never a digit
    expect(id).toContain("z");
    expect(/^@[0-9A-Z]{18}$/.test(id)).toBe(false); // the id is NOT uppercase
    expect(/^@[0-9a-z]{18}$/.test(id)).toBe(true);
  });

  test("PROBE CONTROL: a real random source produces a DIFFERENT id on the next call (rules out an accidentally-constant randomBytes stub)", () => {
    let calls = 0;
    const randomBytes = (n: number) => {
      calls += 1;
      const arr = new Uint8Array(n);
      for (let i = 0; i < n; i++) arr[i] = (calls * 37 + i * 13) & 0xff;
      return arr;
    };
    const first = mintAgentId(randomBytes);
    const second = mintAgentId(randomBytes);
    expect(first).not.toBe(second);
  });

  test("AC5: ids minted with a FIXED clock (i.e. no clock input at all) are unique across many calls in the same instant — guards against randomness accidentally seeded from time", () => {
    // mintAgentId takes NO `now` parameter at all — this is the structural
    // guarantee. This test additionally proves a real randomness source
    // does not collapse to identical bytes when called many times back to
    // back (same "instant" for practical purposes).
    const { randomBytes } = require("node:crypto") as typeof import("node:crypto");
    const ids = new Set<string>();
    for (let i = 0; i < 500; i++) {
      ids.add(mintAgentId((n) => new Uint8Array(randomBytes(n))));
    }
    expect(ids.size).toBe(500);
  });
});

describe("mintUniqueAgentId / isIdTakenOrRetired", () => {
  test("re-rolls when the first candidate collides with an existing agent id", () => {
    const collidingId = mintAgentId((n) => new Uint8Array(n).fill(0x11));
    let state = emptyAgentStore();
    state = putAgent(state, makeAgent({ id: collidingId }));

    let call = 0;
    const randomBytes = (n: number) => {
      call += 1;
      return new Uint8Array(n).fill(call === 1 ? 0x11 : 0x22); // first call collides, second doesn't
    };
    const minted = mintUniqueAgentId(state, randomBytes);
    expect(minted).not.toBe(collidingId);
    expect(call).toBe(2);
  });

  test("re-rolls when the first candidate matches a retired id", () => {
    const retired = mintAgentId((n) => new Uint8Array(n).fill(0x33));
    const state: AgentStoreState = { ...emptyAgentStore(), retiredIds: [retired] };
    expect(isIdTakenOrRetired(state, retired)).toBe(true);

    let call = 0;
    const randomBytes = (n: number) => {
      call += 1;
      return new Uint8Array(n).fill(call === 1 ? 0x33 : 0x44);
    };
    const minted = mintUniqueAgentId(state, randomBytes);
    expect(minted).not.toBe(retired);
  });
});

// --- Name syntax (B3, B5, AC5) ---------------------------------------------

describe("validateNameSyntax", () => {
  test("a plain, non-reserved name is valid — the control that must pass for the refusal tests below to mean anything", () => {
    expect(validateNameSyntax("build")).toEqual({ ok: true });
  });

  test("empty is refused", () => {
    const result = validateNameSyntax("");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("empty");
  });

  test('"@" is refused at every position, not just leading', () => {
    for (const name of ["@build", "bu@ild", "build@", "@"]) {
      const result = validateNameSyntax(name);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("contains-at");
    }
  });

  test("EVERY reserved word is refused", () => {
    for (const word of RESERVED_NAMES) {
      const result = validateNameSyntax(word);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("reserved");
    }
  });

  test("a reserved word is refused for an exact, case-sensitive match only — not a substring or different-case match (documents current behaviour precisely)", () => {
    expect(validateNameSyntax("onward").ok).toBe(true);
    expect(validateNameSyntax("ON").ok).toBe(true);
  });

  test("every refusal carries a non-empty, verbatim-showable message (B11)", () => {
    for (const name of ["", "@x", "on"]) {
      const result = validateNameSyntax(name);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message.length).toBeGreaterThan(0);
    }
  });
});

describe("checkNameAvailability (B4)", () => {
  test("available when nobody in the directory holds the name", () => {
    expect(checkNameAvailability(emptyAgentStore(), DIR_A, "build")).toEqual({ ok: true });
  });

  test("the SAME name in TWO DIRECTORIES is allowed — names are unique per directory, not globally", () => {
    let state = emptyAgentStore();
    state = putAgent(state, makeAgent({ id: "@agent-a", directory: DIR_A, name: "build" }));
    expect(checkNameAvailability(state, DIR_A, "build").ok).toBe(false);
    expect(checkNameAvailability(state, DIR_B, "build").ok).toBe(true); // different directory — no conflict
  });

  test("the same name TWICE in one directory is refused, WITH THE HOLDER ARCHIVED — archived agents keep their name", () => {
    let state = emptyAgentStore();
    state = putAgent(state, makeAgent({ id: "@agent-a", directory: DIR_A, name: "build", state: "archived" }));
    const result = checkNameAvailability(state, DIR_A, "build");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.heldBy.id).toBe("@agent-a");
      expect(result.message).toMatch(/archived/);
    }
  });

  test("excludingAgentId lets an agent's own current name pass as 'available' (for a future rename check)", () => {
    let state = emptyAgentStore();
    state = putAgent(state, makeAgent({ id: "@agent-a", directory: DIR_A, name: "build" }));
    expect(checkNameAvailability(state, DIR_A, "build", "@agent-a").ok).toBe(true);
    expect(checkNameAvailability(state, DIR_A, "build", "@some-other-agent").ok).toBe(false);
  });
});

// --- Membership (B9, R-D) --------------------------------------------------

describe("agentsInDirectory: membership is a derived query, never a stored second copy", () => {
  test("returns only agents whose directory matches, regardless of state", () => {
    let state = emptyAgentStore();
    state = putAgent(state, makeAgent({ id: "@a1", directory: DIR_A, state: "on" }));
    state = putAgent(state, makeAgent({ id: "@a2", directory: DIR_A, state: "off" }));
    state = putAgent(state, makeAgent({ id: "@b1", directory: DIR_B, state: "on" }));

    expect(agentsInDirectory(state, DIR_A).map((a) => a.id).sort()).toEqual(["@a1", "@a2"]);
    expect(agentsInDirectory(state, DIR_B).map((a) => a.id)).toEqual(["@b1"]);
  });

  test("an empty store has no members anywhere", () => {
    expect(agentsInDirectory(emptyAgentStore(), DIR_A)).toEqual([]);
  });
});

// --- The resolver (B4, R-E, AC5) -------------------------------------------

describe("resolveAgent (R-E)", () => {
  test("cannot be called without a scope — TypeScript enforces this at compile time; there is no default and no overload with fewer arguments", () => {
    // Never actually invoked (would throw at runtime with `ref` undefined) —
    // the assertion under test is a COMPILE-time property. `tsc` still
    // typechecks this function body whether or not it runs, so the
    // `@ts-expect-error` below is load-bearing: delete it and
    // `bun run typecheck` must then fail, proving resolveAgent still has no
    // default/optional `scope` parameter.
    function neverCalled(): void {
      // @ts-expect-error - `scope` has no default; this line intentionally fails to compile if resolveAgent ever grows one.
      resolveAgent(emptyAgentStore(), "ref");
    }
    void neverCalled;
    expect(true).toBe(true);
  });

  test("an id resolves globally: found in-scope", () => {
    let state = emptyAgentStore();
    state = putAgent(state, makeAgent({ id: "@a1", directory: DIR_A }));
    expect(resolveAgent(state, DIR_A, "@a1")).toEqual({ outcome: "found", agent: state.agents["@a1"] as AgentRecord });
  });

  test("an id belonging to ANOTHER directory resolves as 'found-elsewhere', carrying that directory — never a false hit, never a bare miss", () => {
    let state = emptyAgentStore();
    state = putAgent(state, makeAgent({ id: "@a1", directory: DIR_B }));
    const result = resolveAgent(state, DIR_A, "@a1");
    expect(result).toEqual({ outcome: "found-elsewhere", agent: state.agents["@a1"] as AgentRecord, directory: DIR_B });
  });

  test("an unknown id is not-found", () => {
    expect(resolveAgent(emptyAgentStore(), DIR_A, "@does-not-exist")).toEqual({ outcome: "not-found" });
  });

  test("a name resolves ONLY within scope — the same name in a different directory is not-found, never a cross-directory suggestion", () => {
    let state = emptyAgentStore();
    state = putAgent(state, makeAgent({ id: "@a1", directory: DIR_B, name: "build" }));
    expect(resolveAgent(state, DIR_A, "build")).toEqual({ outcome: "not-found" });
    expect(resolveAgent(state, DIR_B, "build")).toEqual({ outcome: "found", agent: state.agents["@a1"] as AgentRecord });
  });

  test("an unknown name in-scope is not-found", () => {
    expect(resolveAgent(emptyAgentStore(), DIR_A, "nope")).toEqual({ outcome: "not-found" });
  });
});

// --- Launch bookkeeping, rekeyed to agent id (B8 defect 1 fix, AC4) --------

describe("hasLaunchRecordFor: keyed by AGENT id, not directory (AC4)", () => {
  test("two different agents in the SAME directory each get their own independent guard entry", () => {
    let state = emptyAgentStore();
    state = beginLaunch(state, "@agent-1", DIR_A, undefined, "attempt-1", 1000);
    expect(hasLaunchRecordFor(state, "@agent-1", undefined)).toBe(true);
    expect(hasLaunchRecordFor(state, "@agent-2", undefined)).toBe(false); // NOT defeated by a sibling agent in the same directory
  });
});

describe("resolveLaunch: attaches by AGENT id, never by directory arrival order (the fix for defect 1, AC4)", () => {
  test("fresh launch: sets the requesting agent's birth session id AND restoreTarget", () => {
    let state = emptyAgentStore();
    state = putAgent(state, makeAgent({ id: "@agent-1", directory: DIR_A, birthSessionId: undefined }));
    state = beginLaunch(state, "@agent-1", DIR_A, undefined, "attempt-1", 1000);
    state = markLaunchStarted(state, "attempt-1", "short-1");
    state = resolveLaunch(state, "short-1", "session-uuid-1");

    const agent = state.agents["@agent-1"] as AgentRecord;
    expect(agent.birthSessionId).toBe("session-uuid-1");
    expect(agent.restoreTarget).toEqual({ sessionId: "session-uuid-1", shortId: "short-1" });
    expect(pendingLaunches(state)).toEqual([]);
  });

  test("HEADLINE CONFIGURATION (AC4): two agents launched fresh into the SAME directory in the SAME cycle each end up holding their OWN session, regardless of which short id resolves first", () => {
    let state = emptyAgentStore();
    state = putAgent(state, makeAgent({ id: "@agent-1", directory: DIR_A }));
    state = putAgent(state, makeAgent({ id: "@agent-2", directory: DIR_A }));

    state = beginLaunch(state, "@agent-1", DIR_A, undefined, "attempt-1", 1000);
    state = beginLaunch(state, "@agent-2", DIR_A, undefined, "attempt-2", 1000);
    state = markLaunchStarted(state, "attempt-1", "short-1");
    state = markLaunchStarted(state, "attempt-2", "short-2");

    // Resolve OUT OF ORDER (agent-2's short id resolves first) — arrival order must not matter.
    state = resolveLaunch(state, "short-2", "session-for-agent-2");
    state = resolveLaunch(state, "short-1", "session-for-agent-1");

    expect((state.agents["@agent-1"] as AgentRecord).birthSessionId).toBe("session-for-agent-1");
    expect((state.agents["@agent-2"] as AgentRecord).birthSessionId).toBe("session-for-agent-2");
  });

  test("forkFrom: updates ONLY restoreTarget — birthSessionId is NEVER overwritten (BAKR-22: the moved-directory escape must never touch birth provenance)", () => {
    let state = emptyAgentStore();
    state = putAgent(state, makeAgent({ id: "@agent-1", directory: DIR_A, birthSessionId: "durable-1", restoreTarget: { sessionId: "durable-1", shortId: "durabl-1" } }));
    state = beginLaunch(state, "@agent-1", DIR_A, { kind: "forkFrom", sessionId: "durable-1" }, "attempt-2", 2000);
    state = markLaunchStarted(state, "attempt-2", "short-2");
    state = resolveLaunch(state, "short-2", "forked-session-id");

    const agent = state.agents["@agent-1"] as AgentRecord;
    expect(agent.birthSessionId).toBe("durable-1"); // unchanged
    expect(agent.restoreTarget).toEqual({ sessionId: "forked-session-id", shortId: "short-2" });
  });

  test("a forkFrom whose sessionId no longer matches the agent's CURRENT restoreTarget.sessionId is a defensive no-op on the agent (never silently reassigns the restore target from a stale source)", () => {
    let state = emptyAgentStore();
    state = putAgent(state, makeAgent({ id: "@agent-1", directory: DIR_A, birthSessionId: "durable-current", restoreTarget: { sessionId: "durable-current", shortId: "durabl-c" } }));
    state = beginLaunch(state, "@agent-1", DIR_A, { kind: "forkFrom", sessionId: "stale-durable-id" }, "attempt-1", 1000);
    state = markLaunchStarted(state, "attempt-1", "short-1");
    state = resolveLaunch(state, "short-1", "new-live-id");

    expect((state.agents["@agent-1"] as AgentRecord).restoreTarget).toEqual({ sessionId: "durable-current", shortId: "durabl-c" });
  });

  test("a respawn-kind attemptKey resolving via resolveLaunch touches nothing on the agent — respawn attempts resolve synchronously via resolveRespawnAttempt instead, never through this function", () => {
    let state = emptyAgentStore();
    state = putAgent(state, makeAgent({ id: "@agent-1", directory: DIR_A, birthSessionId: "durable-1", restoreTarget: { sessionId: "durable-1", shortId: "durabl-1" } }));
    state = beginLaunch(state, "@agent-1", DIR_A, { kind: "respawn", shortId: "durabl-1" }, "attempt-2", 2000);
    state = markLaunchStarted(state, "attempt-2", "short-2");
    const before = state.agents["@agent-1"];
    state = resolveLaunch(state, "short-2", "some-session-id");
    expect(state.agents["@agent-1"]).toEqual(before as AgentRecord);
  });

  test("resolving an unknown short id is a no-op, not an error", () => {
    const state = emptyAgentStore();
    expect(() => resolveLaunch(state, "no-such-short-id", "session-uuid")).not.toThrow();
    expect(resolveLaunch(state, "no-such-short-id", "session-uuid")).toEqual(state);
  });

  test("if the agent no longer exists (defensive), the launch record is still removed rather than left to wedge", () => {
    let state = emptyAgentStore();
    state = beginLaunch(state, "@ghost-agent", DIR_A, undefined, "attempt-1", 1000);
    state = markLaunchStarted(state, "attempt-1", "short-1");
    state = resolveLaunch(state, "short-1", "session-uuid-1");
    expect(pendingLaunches(state)).toEqual([]);
    expect(state.agents["@ghost-agent"]).toBeUndefined();
  });
});

describe("BAKR-33: a successful resolution drops that SAME agent's other stale error records", () => {
  test("resolveRespawnAttempt success drops an older FAILED record for the same agent under a DIFFERENT key, and leaves a sibling agent's failed record untouched", () => {
    let state = emptyAgentStore();
    state = putAgent(state, makeAgent({ id: "@a1", directory: DIR_A, restoreTarget: { sessionId: "durable-1", shortId: "old-short" } }));
    state = putAgent(state, makeAgent({ id: "@a2", directory: DIR_A, restoreTarget: { sessionId: "durable-2", shortId: "other-short" } }));
    // @a1's stale, already-given-up record from an earlier failed respawn attempt (a different shortId).
    state = beginLaunch(state, "@a1", DIR_A, { kind: "respawn", shortId: "old-short" }, "stale-attempt", 1000);
    state = markLaunchFailed(state, "stale-attempt", "respawn refused: TOCTOU re-check reported \"alive\"");
    // @a2's own failed record — must survive @a1's resolution untouched.
    state = beginLaunch(state, "@a2", DIR_A, { kind: "respawn", shortId: "other-short" }, "a2-failed", 1000);
    state = markLaunchFailed(state, "a2-failed", "some unrelated refusal");

    // @a1 is later relaunched successfully (a fresh attempt, new attemptId, same shortId key here for simplicity).
    state = beginLaunch(state, "@a1", DIR_A, { kind: "respawn", shortId: "old-short" }, "new-attempt", 2000);
    state = resolveRespawnAttempt(state, "new-attempt", "new-short");

    expect(unresolvedLaunches(state).map((l) => l.attemptId)).toEqual(["a2-failed"]);
    expect(state.launches.some((l) => l.attemptId === "stale-attempt")).toBe(false);
    expect((state.agents["@a1"] as AgentRecord).restoreTarget?.shortId).toBe("new-short");
  });

  test("resolveRespawnAttempt never touches a still-PENDING record for the same agent (an in-flight launch is never stale)", () => {
    let state = emptyAgentStore();
    state = putAgent(state, makeAgent({ id: "@a1", directory: DIR_A, restoreTarget: { sessionId: "durable-1", shortId: "old-short" } }));
    state = beginLaunch(state, "@a1", DIR_A, undefined, "pending-fresh", 1000); // a genuinely in-flight fresh launch, never resolved or failed
    state = beginLaunch(state, "@a1", DIR_A, { kind: "respawn", shortId: "old-short" }, "resolving-now", 2000);

    state = resolveRespawnAttempt(state, "resolving-now", "new-short");

    expect(state.launches.map((l) => l.attemptId)).toEqual(["pending-fresh"]);
  });

  test("resolveLaunch (fresh/forkFrom success) also drops that agent's older failed records", () => {
    let state = emptyAgentStore();
    state = putAgent(state, makeAgent({ id: "@a1", directory: DIR_A, birthSessionId: undefined, restoreTarget: undefined }));
    state = beginLaunch(state, "@a1", DIR_A, { kind: "respawn", shortId: "long-gone" }, "stale-attempt", 1000);
    state = markLaunchFailed(state, "stale-attempt", "gave up after 3 consecutive restore attempts");

    state = beginLaunch(state, "@a1", DIR_A, undefined, "fresh-attempt", 2000);
    state = markLaunchStarted(state, "fresh-attempt", "short-1");
    state = resolveLaunch(state, "short-1", "session-uuid-1");

    expect(state.launches).toEqual([]);
    expect((state.agents["@a1"] as AgentRecord).birthSessionId).toBe("session-uuid-1");
  });
});

describe("failed launches: permanently unresolved, never auto-cleared (ported)", () => {
  test("markLaunchFailed moves a record out of pendingLaunches and into unresolvedLaunches", () => {
    let state = emptyAgentStore();
    state = beginLaunch(state, "@agent-1", DIR_A, undefined, "attempt-1", 1000);
    state = markLaunchFailed(state, "attempt-1", "launch exited 1: boom");
    expect(pendingLaunches(state)).toHaveLength(0);
    expect(unresolvedLaunches(state)).toHaveLength(1);
  });
});

describe("promoteUnresolvableLaunches: closes the crash-mid-launch wedge (ported)", () => {
  test("a record with no launchShortId and no error is promoted to unresolved", () => {
    let state = emptyAgentStore();
    state = beginLaunch(state, "@agent-1", DIR_A, { kind: "respawn", shortId: "prior-id" }, "attempt-1", 1000);
    state = promoteUnresolvableLaunches(state, "crashed mid-launch");
    expect(unresolvedLaunches(state)).toHaveLength(1);
    expect(unresolvedLaunches(state)[0]?.error).toBe("crashed mid-launch");
  });

  test("does not touch a record already in flight or already failed", () => {
    let state = emptyAgentStore();
    state = beginLaunch(state, "@agent-1", DIR_A, undefined, "in-flight", 1000);
    state = markLaunchStarted(state, "in-flight", "short-1");
    const before = state;
    state = promoteUnresolvableLaunches(state, "crashed mid-launch");
    expect(state).toEqual(before);
  });
});

describe("restoreAttemptCount / recordRestoreAttempt / resetRestoreAttempts: rekeyed to AGENT id (R-C)", () => {
  test("independent per agent id — an alive sibling agent cannot reset a failing agent's count", () => {
    let state = emptyAgentStore();
    state = recordRestoreAttempt(state, "@agent-1");
    state = recordRestoreAttempt(state, "@agent-1");
    state = recordRestoreAttempt(state, "@agent-2");
    state = resetRestoreAttempts(state, "@agent-2");
    expect(restoreAttemptCount(state, "@agent-1")).toBe(2);
    expect(restoreAttemptCount(state, "@agent-2")).toBe(0);
  });

  test("resetRestoreAttempts is a true no-op (identical object) when already zero", () => {
    const state = emptyAgentStore();
    expect(resetRestoreAttempts(state, "@agent-1")).toBe(state);
  });
});

// --- Wire format ------------------------------------------------------

describe("wire format round-trip", () => {
  function expectRoundTrips(state: AgentStoreState): void {
    const parsed = parseAgentStoreState(serializeAgentStoreState(state));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.state).toEqual(state);
  }

  test("an empty store round-trips", () => {
    expectRoundTrips(emptyAgentStore());
  });

  test("a store with agents, launches, retired ids, and retry counts round-trips", () => {
    let state = emptyAgentStore();
    state = putAgent(state, makeAgent({ id: "@a1", name: "build", directory: DIR_A, birthSessionId: "d1", restoreTarget: { sessionId: "l1", shortId: "l1shortx" } }));
    state = putAgent(state, makeAgent({ id: "@a2", directory: DIR_B, state: "archived" }));
    state = beginLaunch(state, "@a1", DIR_A, { kind: "respawn", shortId: "d1short0" }, "attempt-1", 1000);
    state = markLaunchFailed(state, "attempt-1", "boom");
    state = recordRestoreAttempt(state, "@a1");
    state = { ...state, retiredIds: ["@retired-1"] };
    expectRoundTrips(state);
  });

  test("a store with a forkFrom-kind launch record round-trips", () => {
    let state = emptyAgentStore();
    state = putAgent(state, makeAgent({ id: "@a1", directory: DIR_A, birthSessionId: "d1", restoreTarget: { sessionId: "d1", shortId: "d1short0" } }));
    state = beginLaunch(state, "@a1", DIR_A, { kind: "forkFrom", sessionId: "d1" }, "attempt-1", 1000);
    expectRoundTrips(state);
  });

  test("invalid JSON is reported as a typed error, never thrown", () => {
    expect(parseAgentStoreState("{not json").ok).toBe(false);
  });

  test("valid JSON with the wrong shape is reported as a typed error", () => {
    expect(parseAgentStoreState(JSON.stringify({ hello: "world" })).ok).toBe(false);
  });

  test("a wrong version number is reported as a typed error", () => {
    expect(parseAgentStoreState(JSON.stringify({ version: 3, agents: {}, retiredIds: [], launches: [], restoreAttemptCounts: {} })).ok).toBe(false);
  });

  test("an invalid lifecycle state value is reported as a typed error", () => {
    const bad = { version: 2, agents: { "@a1": { id: "@a1", name: null, directory: "/x", state: "paused", createdAt: 1, birthSessionId: null, restoreTarget: null } }, launches: [] };
    expect(parseAgentStoreState(JSON.stringify(bad)).ok).toBe(false);
  });

  test("retiredIds and restoreAttemptCounts are OPTIONAL in the persisted shape — absence defaults, not malformed", () => {
    const result = parseAgentStoreState(JSON.stringify({ version: 2, agents: {}, launches: [] }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state.retiredIds).toEqual([]);
      expect(result.state.restoreAttemptCounts).toEqual({});
    }
  });

  test("a PRESENT but invalid retiredIds/restoreAttemptCounts is still rejected — a default for absence, not a loosened shape check", () => {
    expect(parseAgentStoreState(JSON.stringify({ version: 2, agents: {}, launches: [], retiredIds: "not-an-array" })).ok).toBe(false);
    expect(parseAgentStoreState(JSON.stringify({ version: 2, agents: {}, launches: [], restoreAttemptCounts: { a: "x" } })).ok).toBe(false);
  });

  test("a malformed agent entry is reported as a typed error", () => {
    expect(parseAgentStoreState(JSON.stringify({ version: 2, agents: { "@a1": { id: "@a1" } }, launches: [] })).ok).toBe(false);
  });

  test("a malformed launch record is reported as a typed error", () => {
    expect(parseAgentStoreState(JSON.stringify({ version: 2, agents: {}, launches: [{ attemptId: 5 }] })).ok).toBe(false);
  });

  // --- BAKR-22: v1 -> v2 migration, in-memory, on parse -------------------

  describe("v1 store migration (durableSessionId/liveSessionId/priorSessionId -> birthSessionId/restoreTarget/attemptKey)", () => {
    test("a plain v1 agent (no fork ever happened: durableSessionId === liveSessionId) migrates cleanly", () => {
      const v1 = {
        version: 1,
        agents: {
          "@a1": { id: "@a1", name: null, directory: "/x", state: "on", createdAt: 1000, durableSessionId: "abcd1234-full-uuid", liveSessionId: "abcd1234-full-uuid" },
        },
        launches: [],
      };
      const result = parseAgentStoreState(JSON.stringify(v1));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const agent = result.state.agents["@a1"] as AgentRecord;
      expect(agent.birthSessionId).toBe("abcd1234-full-uuid");
      expect(agent.restoreTarget).toEqual({ sessionId: "abcd1234-full-uuid", shortId: "abcd1234" });
    });

    test("THE SUBTLE CASE: a v1 agent whose liveSessionId is a 2.1.251-era FORK of its durableSessionId — restoreTarget must prefer the MORE RECENT liveSessionId, never fall back to birth", () => {
      const v1 = {
        version: 1,
        agents: {
          "@a1": { id: "@a1", name: null, directory: "/x", state: "on", createdAt: 1000, durableSessionId: "birth0000-uuid", liveSessionId: "forked111-uuid" },
        },
        launches: [],
      };
      const result = parseAgentStoreState(JSON.stringify(v1));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const agent = result.state.agents["@a1"] as AgentRecord;
      expect(agent.birthSessionId).toBe("birth0000-uuid"); // birth provenance preserved exactly
      expect(agent.restoreTarget).toEqual({ sessionId: "forked111-uuid", shortId: "forked11" }); // but restore advances to the fork, not birth
    });

    test("a v1 agent with no session at all yet gets no restoreTarget either — planRestore already treats that as fresh", () => {
      const v1 = { version: 1, agents: { "@a1": { id: "@a1", name: null, directory: "/x", state: "on", createdAt: 1000, durableSessionId: null, liveSessionId: null } }, launches: [] };
      const result = parseAgentStoreState(JSON.stringify(v1));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const agent = result.state.agents["@a1"] as AgentRecord;
      expect(agent.birthSessionId).toBeUndefined();
      expect(agent.restoreTarget).toBeUndefined();
    });

    test("a v1 launch record's priorSessionId migrates to a respawn-kind attemptKey, derived-short-id-consistent with the agent's own migrated restoreTarget (B13 give-up survives migration)", () => {
      const v1 = {
        version: 1,
        agents: {
          "@a1": { id: "@a1", name: null, directory: "/x", state: "on", createdAt: 1000, durableSessionId: "given0000-up-uuid", liveSessionId: "given0000-up-uuid" },
        },
        launches: [{ attemptId: "att-1", agentId: "@a1", key: "/x", priorSessionId: "given0000-up-uuid", attemptedAt: 1, launchShortId: null, error: "gave up" }],
      };
      const result = parseAgentStoreState(JSON.stringify(v1));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const agent = result.state.agents["@a1"] as AgentRecord;
      const launch = result.state.launches[0];
      expect(launch?.attemptKey).toEqual({ kind: "respawn", shortId: "given000" });
      expect(agent.restoreTarget?.shortId).toBe("given000"); // same derived short id — the give-up still matches on the next respawn attempt
    });

    test("a v1 fresh-launch attempt (priorSessionId absent) stays a fresh (undefined) attemptKey after migration", () => {
      const v1 = {
        version: 1,
        agents: {},
        launches: [{ attemptId: "att-1", agentId: "@a1", key: "/x", priorSessionId: null, attemptedAt: 1, launchShortId: null, error: "boom" }],
      };
      const result = parseAgentStoreState(JSON.stringify(v1));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.state.launches[0]?.attemptKey).toBeUndefined();
    });

    test("a v2 store round-tripped through v1-shaped parsing paths is rejected as malformed (v1 agent entries require durableSessionId/liveSessionId, not birthSessionId/restoreTarget)", () => {
      const mixedUp = { version: 1, agents: { "@a1": { id: "@a1", name: null, directory: "/x", state: "on", createdAt: 1, birthSessionId: "x", restoreTarget: null } }, launches: [] };
      expect(parseAgentStoreState(JSON.stringify(mixedUp)).ok).toBe(false);
    });
  });
});
