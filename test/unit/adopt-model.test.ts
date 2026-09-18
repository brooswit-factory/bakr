import { describe, expect, test } from "bun:test";
import { validateAdopt, applyAdopt, decideAdopt, type AdoptInputs } from "../../src/adopt-model";
import { emptyAgentStore, putAgent, beginLaunch, markLaunchFailed, lookupAgentById, hasLaunchRecordFor, restoreAttemptCount, recordRestoreAttempt, type AgentRecord, type AgentStoreState } from "../../src/agent-model";
import type { ClaimKey } from "../../src/claim-key-resolve";

const SOURCE = "/old/path" as ClaimKey;
const DEST = "/new/path" as ClaimKey;

function makeAgent(overrides: Partial<AgentRecord> & { id: string; directory: ClaimKey }): AgentRecord {
  return { name: undefined, state: "on", createdAt: 1, birthSessionId: undefined, restoreTarget: undefined, ...overrides };
}

function baseInputs(overrides: Partial<AdoptInputs> & { agentState: AgentStoreState }): AdoptInputs {
  return { source: SOURCE, destination: DEST, agentIds: [], sourceVerdictStatus: "gone", ...overrides };
}

describe("empty-selection", () => {
  test("refused with no agents named", () => {
    const result = validateAdopt(baseInputs({ agentState: emptyAgentStore(), agentIds: [] }));
    expect(result).toEqual({ ok: false, reason: "empty-selection", message: expect.any(String) });
  });
  test("CONTROL: naming at least one agent passes this check (proceeds past it)", () => {
    const agentState = putAgent(emptyAgentStore(), makeAgent({ id: "@a1", directory: SOURCE }));
    const result = validateAdopt(baseInputs({ agentState, agentIds: ["@a1"] }));
    expect(result.ok).toBe(true);
  });
});

describe("destination-is-source", () => {
  test("refused when destination equals source", () => {
    const agentState = putAgent(emptyAgentStore(), makeAgent({ id: "@a1", directory: SOURCE }));
    const result = validateAdopt(baseInputs({ agentState, agentIds: ["@a1"], destination: SOURCE }));
    expect(result).toEqual({ ok: false, reason: "destination-is-source", message: expect.any(String) });
  });
  test("CONTROL: a genuinely different destination passes this check", () => {
    const agentState = putAgent(emptyAgentStore(), makeAgent({ id: "@a1", directory: SOURCE }));
    const result = validateAdopt(baseInputs({ agentState, agentIds: ["@a1"], destination: DEST }));
    expect(result.ok).toBe(true);
  });
});

describe("source-not-orphaned", () => {
  test("refused when the source directory still resolves (verdict: present)", () => {
    const agentState = putAgent(emptyAgentStore(), makeAgent({ id: "@a1", directory: SOURCE }));
    const result = validateAdopt(baseInputs({ agentState, agentIds: ["@a1"], sourceVerdictStatus: "present" }));
    expect(result).toEqual({ ok: false, reason: "source-not-orphaned", message: expect.any(String) });
  });
  test("CONTROL: verdict gone passes this check", () => {
    const agentState = putAgent(emptyAgentStore(), makeAgent({ id: "@a1", directory: SOURCE }));
    const result = validateAdopt(baseInputs({ agentState, agentIds: ["@a1"], sourceVerdictStatus: "gone" }));
    expect(result.ok).toBe(true);
  });
});

describe("source-unavailable", () => {
  test("refused when the source cannot be classified (verdict: unavailable) — we cannot distinguish gone from temporarily-down", () => {
    const agentState = putAgent(emptyAgentStore(), makeAgent({ id: "@a1", directory: SOURCE }));
    const result = validateAdopt(baseInputs({ agentState, agentIds: ["@a1"], sourceVerdictStatus: "unavailable" }));
    expect(result).toEqual({ ok: false, reason: "source-unavailable", message: expect.any(String) });
  });
  test("CONTROL: verdict gone passes this check", () => {
    const agentState = putAgent(emptyAgentStore(), makeAgent({ id: "@a1", directory: SOURCE }));
    const result = validateAdopt(baseInputs({ agentState, agentIds: ["@a1"], sourceVerdictStatus: "gone" }));
    expect(result.ok).toBe(true);
  });
});

describe("unknown-agent", () => {
  test("refused, naming every id not in the store", () => {
    const agentState = putAgent(emptyAgentStore(), makeAgent({ id: "@a1", directory: SOURCE }));
    const result = validateAdopt(baseInputs({ agentState, agentIds: ["@a1", "@ghost"] }));
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "unknown-agent") {
      expect(result.agentIds).toEqual(["@ghost"]);
    } else {
      throw new Error(`expected unknown-agent, got ${JSON.stringify(result)}`);
    }
  });
  test("CONTROL: every named id existing in the store passes this check", () => {
    const agentState = putAgent(emptyAgentStore(), makeAgent({ id: "@a1", directory: SOURCE }));
    const result = validateAdopt(baseInputs({ agentState, agentIds: ["@a1"] }));
    expect(result.ok).toBe(true);
  });
});

describe("agent-not-in-source (covers BOTH 'never was in source' and the concurrent-adopt-race 'agents-already-adopted' scenario — see adopt-model.ts's own module comment for why these collapse to one typed check)", () => {
  test("scenario A: a real agent whose directory was never the named source (a caller error — wrong id, or wrong source)", () => {
    const elsewhere = "/somewhere/else" as ClaimKey;
    const agentState = putAgent(emptyAgentStore(), makeAgent({ id: "@a1", directory: elsewhere }));
    const result = validateAdopt(baseInputs({ agentState, agentIds: ["@a1"] }));
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "agent-not-in-source") {
      expect(result.agents).toEqual([{ id: "@a1", currentDirectory: elsewhere }]);
    } else {
      throw new Error(`expected agent-not-in-source, got ${JSON.stringify(result)}`);
    }
  });

  test("scenario B (Q3's own 'second adopter' race): an agent that WAS in source, but a first adopt already moved it elsewhere before this validation runs — the second adopter's refusal names the CURRENT directory", () => {
    let agentState = putAgent(emptyAgentStore(), makeAgent({ id: "@a1", directory: SOURCE }));
    // Simulate a first adopt already having applied, moving @a1 out of SOURCE.
    const firstAdopt = applyAdopt(agentState, DEST, ["@a1"]);
    agentState = firstAdopt.state;

    // The second adopter re-validates against the SAME source and agent id, now stale.
    const result = validateAdopt(baseInputs({ agentState, agentIds: ["@a1"] }));
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "agent-not-in-source") {
      expect(result.agents).toEqual([{ id: "@a1", currentDirectory: DEST }]); // names WHERE it went
    } else {
      throw new Error(`expected agent-not-in-source, got ${JSON.stringify(result)}`);
    }
  });

  test("CONTROL: an agent genuinely still in source passes this check", () => {
    const agentState = putAgent(emptyAgentStore(), makeAgent({ id: "@a1", directory: SOURCE }));
    const result = validateAdopt(baseInputs({ agentState, agentIds: ["@a1"] }));
    expect(result.ok).toBe(true);
  });
});

// BAKR-34/BAKR-42 R9: custom names (and the per-directory name-collision
// check that used to run here) are retired — an agent's name is derived
// from its directory now (R1/R3), so there is no custom-name value left for
// two agents to collide over. Adopting into a directory that already holds
// a non-archived agent is not refused by adopt.ts (see adopt-model.ts's own
// module comment: R6's one-per-directory line is drawn at `create` /
// `bakr <real path>` create, not at adopt) — the destination simply ends up
// with more than one non-archived agent, the identical legacy shape R6
// already requires the store to keep loading and resolving through
// (AMBIGUOUS by name, both reachable by @id).
describe("adopting into an already-occupied destination (R9/R6)", () => {
  test("a stale legacy `name` on the moved agent is no longer checked against the destination at all — adopt succeeds regardless", () => {
    let agentState = putAgent(emptyAgentStore(), makeAgent({ id: "@a1", directory: SOURCE, name: "worker" }));
    agentState = putAgent(agentState, makeAgent({ id: "@holder", directory: DEST, name: "worker" }));
    const result = validateAdopt(baseInputs({ agentState, agentIds: ["@a1"] }));
    expect(result.ok).toBe(true);
  });

  test("adopting a non-archived agent into a destination that already holds one succeeds — the resulting directory becomes the same legacy-ambiguous shape R6 already tolerates, not an adopt-time refusal", () => {
    let agentState = putAgent(emptyAgentStore(), makeAgent({ id: "@a1", directory: SOURCE }));
    agentState = putAgent(agentState, makeAgent({ id: "@resident", directory: DEST }));
    const result = validateAdopt(baseInputs({ agentState, agentIds: ["@a1"] }));
    expect(result.ok).toBe(true);
  });
});

describe("applyAdopt: the single state transition (Q3/Q5/Q7)", () => {
  test("moves ALL named agents' directory to destination in one transition, resets retry counts, and discards ALL their launch records — reporting each cleared one (B13)", () => {
    let agentState = putAgent(emptyAgentStore(), makeAgent({ id: "@a1", directory: SOURCE }));
    agentState = putAgent(agentState, makeAgent({ id: "@a2", directory: SOURCE }));
    agentState = recordRestoreAttempt(agentState, "@a1");
    agentState = recordRestoreAttempt(agentState, "@a1");
    agentState = beginLaunch(agentState, "@a1", SOURCE, { kind: "respawn", shortId: "some-session" }, "attempt-1", 100);
    agentState = markLaunchFailed(agentState, "attempt-1", "gave up after 3 consecutive restore attempts — unrelated to the move (BAKR-24 required fixture)");

    const result = applyAdopt(agentState, DEST, ["@a1", "@a2"]);

    expect(lookupAgentById(result.state, "@a1")?.directory).toBe(DEST);
    expect(lookupAgentById(result.state, "@a2")?.directory).toBe(DEST);
    expect(restoreAttemptCount(result.state, "@a1")).toBe(0);
    expect(hasLaunchRecordFor(result.state, "@a1", { kind: "respawn", shortId: "some-session" })).toBe(false);
    expect(result.clearedLaunchRecords).toEqual([{ agentId: "@a1", attemptId: "attempt-1", error: expect.stringContaining("gave up after 3 consecutive restore attempts") }]);
  });

  test("REQUIRED FIXTURE (B13/Q5, named explicitly by the epic): a given-up launch record whose cause is UNRELATED to the move is discarded on adopt, and the agent becomes eligible to restore in its new home, AND adopt's typed result reports it as cleared", () => {
    let agentState = putAgent(emptyAgentStore(), makeAgent({ id: "@a1", directory: SOURCE, birthSessionId: "durable-x", restoreTarget: { sessionId: "durable-x", shortId: "durable-x" } }));
    // A give-up recorded for a reason that has NOTHING to do with the directory moving (e.g. a flaky network blip during the original restore attempts).
    agentState = beginLaunch(agentState, "@a1", SOURCE, { kind: "respawn", shortId: "durable-x" }, "given-up-attempt", 100);
    agentState = markLaunchFailed(agentState, "given-up-attempt", "gave up after 3 consecutive restore attempts for this agent, none independently verified alive — likely a silently-failing resume (ticket measurement 5); never retried automatically (BAKR-8 Constraint 2)");

    // Before adopt: this agent IS blocked from a fresh restore attempt (hasLaunchRecordFor is true for its durable session).
    expect(hasLaunchRecordFor(agentState, "@a1", { kind: "respawn", shortId: "durable-x" })).toBe(true);

    const decision = decideAdopt({ agentState, source: SOURCE, destination: DEST, agentIds: ["@a1"], sourceVerdictStatus: "gone" });
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;

    // BOTH assertions B13 requires: discarded, AND reported.
    expect(hasLaunchRecordFor(decision.state, "@a1", { kind: "respawn", shortId: "durable-x" })).toBe(false); // eligible to restore in its new home
    expect(decision.clearedLaunchRecords).toEqual([{ agentId: "@a1", attemptId: "given-up-attempt", error: expect.stringContaining("gave up after 3 consecutive restore attempts") }]);
  });

  test("records belonging to agents that were NOT adopted are untouched", () => {
    let agentState = putAgent(emptyAgentStore(), makeAgent({ id: "@a1", directory: SOURCE }));
    agentState = putAgent(agentState, makeAgent({ id: "@untouched", directory: SOURCE }));
    agentState = beginLaunch(agentState, "@untouched", SOURCE, { kind: "respawn", shortId: "other-session" }, "other-attempt", 100);
    agentState = markLaunchFailed(agentState, "other-attempt", "unrelated give-up");

    const result = applyAdopt(agentState, DEST, ["@a1"]);
    expect(hasLaunchRecordFor(result.state, "@untouched", { kind: "respawn", shortId: "other-session" })).toBe(true);
    expect(lookupAgentById(result.state, "@untouched")?.directory).toBe(SOURCE); // never moved
    expect(result.clearedLaunchRecords).toEqual([]); // nothing cleared for @a1 (it had no records) and @untouched wasn't adopted
  });
});

describe("decideAdopt: validate-then-apply combinator", () => {
  test("a refused validation short-circuits — no state transition, no cleared-records reporting", () => {
    const agentState = putAgent(emptyAgentStore(), makeAgent({ id: "@a1", directory: SOURCE }));
    const decision = decideAdopt({ agentState, source: SOURCE, destination: DEST, agentIds: [], sourceVerdictStatus: "gone" });
    expect(decision).toEqual({ ok: false, reason: "empty-selection", message: expect.any(String) });
  });

  test("CONTROL: a fully valid request succeeds end to end through the combinator", () => {
    const agentState = putAgent(emptyAgentStore(), makeAgent({ id: "@a1", directory: SOURCE }));
    const decision = decideAdopt({ agentState, source: SOURCE, destination: DEST, agentIds: ["@a1"], sourceVerdictStatus: "gone" });
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.adoptedAgentIds).toEqual(["@a1"]);
      expect(lookupAgentById(decision.state, "@a1")?.directory).toBe(DEST);
    }
  });
});
