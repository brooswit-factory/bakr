// DoD item 3: the pure transition table, unit-tested exhaustively — every
// refusal and every "no change" case, each WITH a control proving a
// permitted transition through the same decision function still passes (a
// table that refuses everything would pass a test that only checks
// refusals). No filesystem, no lock, no spawn substrate anywhere in this
// file — everything here is a pure function of a store snapshot.

import { describe, expect, test } from "bun:test";
import { type AgentRecord, type RefClassification, emptyAgentStore, putAgent, type AgentStoreState } from "../../src/agent-model";
import {
  decideArchive,
  decideAttachTarget,
  decideCreate,
  decideDelete,
  decideOff,
  decideOn,
  decideUnarchive,
} from "../../src/agent-lifecycle";
import type { ClaimKey } from "../../src/claim-key-resolve";

const DIR_A = "/home/alice/project" as ClaimKey;
const DIR_B = "/home/alice/other" as ClaimKey;
const byId = (ref: string): RefClassification => ({ kind: "id", ref });
const byName = (ref: string): RefClassification => ({ kind: "name", ref });
const byDirectory = (directory: ClaimKey): RefClassification => ({ kind: "directory", directory });

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

function storeWith(...agents: AgentRecord[]): AgentStoreState {
  let state = emptyAgentStore();
  for (const agent of agents) state = putAgent(state, agent);
  return state;
}

// --- Shared resolution: not-found / ambiguous / renamed, exercised through every verb (R4/R6/R8) ---

describe("resolution, shared by every verb", () => {
  test("not-found: unknown id", () => {
    const state = storeWith(makeAgent({ id: "@a1" }));
    const decision = decideOn(state, byId("@doesnotexist00000"));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("not-found");
  });

  test("not-found: unknown name", () => {
    const state = storeWith(makeAgent({ id: "@a1", name: "real" }));
    const decision = decideOn(state, byName("notreal"));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("not-found");
  });

  test("not-found message names the id as deleted when it is in retiredIds (delete's own note)", () => {
    const state = { ...emptyAgentStore(), retiredIds: ["@retired00000000000"] };
    const decision = decideOn(state, byId("@retired00000000000"));
    expect(decision.ok).toBe(false);
    if (!decision.ok && decision.reason === "not-found") {
      expect(decision.message).toContain("deleted");
    } else {
      throw new Error("expected not-found");
    }
  });

  test("R4: an id resolves globally — no directory input exists to be 'elsewhere' from any more", () => {
    const state = storeWith(makeAgent({ id: "@a1", directory: DIR_B, state: "off" }));
    const decision = decideOn(state, byId("@a1"));
    expect(decision.ok).toBe(true);
  });

  test("R4: a name resolves against the CURRENT global derived-name set (DIR_B's derived name is 'alice/other')", () => {
    const state = storeWith(makeAgent({ id: "@a1", directory: DIR_B, state: "off" }));
    const decision = decideOn(state, byName("alice/other"));
    expect(decision.ok).toBe(true);
  });

  test("R6: a directory (real-path ref) held by two non-archived agents refuses AMBIGUOUS, naming both @ids — never bricks, never picks one arbitrarily", () => {
    const state = storeWith(makeAgent({ id: "@a1", directory: DIR_A }), makeAgent({ id: "@a2", directory: DIR_A }));
    const decision = decideOn(state, byDirectory(DIR_A));
    expect(decision.ok).toBe(false);
    if (!decision.ok && decision.reason === "ambiguous") {
      expect([...decision.agentIds].sort()).toEqual(["@a1", "@a2"]);
    } else {
      throw new Error("expected ambiguous");
    }
  });

  test("R8: a stale legacy `name` refuses 'renamed', naming the current derived name, and changes nothing", () => {
    const state = storeWith(makeAgent({ id: "@a1", directory: DIR_A, name: "old-custom-name", state: "off" }));
    const decision = decideOn(state, byName("old-custom-name"));
    expect(decision.ok).toBe(false);
    if (!decision.ok && decision.reason === "renamed") {
      expect(decision.derivedName).toBe("alice/project");
      expect(decision.message).toContain("alice/project");
    } else {
      throw new Error("expected renamed");
    }
    // Nothing changed: the agent is still off, still named "old-custom-name" in the store.
    expect(state.agents["@a1"]?.state).toBe("off");
    expect(state.agents["@a1"]?.name).toBe("old-custom-name");
  });

  test("CONTROL: a real, resolvable id resolves", () => {
    const state = storeWith(makeAgent({ id: "@a1", state: "off" }));
    const decision = decideOn(state, byId("@a1"));
    expect(decision.ok).toBe(true);
  });
});

// --- on: off -> on, refused while archived, no-change on the diagonal ---

describe("decideOn", () => {
  test("refused while archived — never a silent unarchive", () => {
    const state = storeWith(makeAgent({ id: "@a1", state: "archived" }));
    const decision = decideOn(state, byId("@a1"));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("archived");
  });

  test("already on: wasOff is false, agent unchanged (the launch-record wedge check is agent-actions.ts's job, not this pure function's)", () => {
    const state = storeWith(makeAgent({ id: "@a1", state: "on", restoreTarget: { sessionId: "sess-1", shortId: "sess-1s" } }));
    const decision = decideOn(state, byId("@a1"));
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.wasOff).toBe(false);
      expect(decision.agent.state).toBe("on");
      expect(decision.plan).toEqual({ kind: "respawn", shortId: "sess-1s" }); // still computed — agent-actions.ts's `on` needs it for the wedge check even when not transitioning
    }
  });

  test("CONTROL: off -> on with a restoreTarget respawns that short id", () => {
    const state = storeWith(makeAgent({ id: "@a1", state: "off", restoreTarget: { sessionId: "sess-1", shortId: "sess-1s" } }));
    const decision = decideOn(state, byId("@a1"));
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.wasOff).toBe(true);
      expect(decision.agent.state).toBe("on");
      expect(decision.plan).toEqual({ kind: "respawn", shortId: "sess-1s" });
    }
  });

  test("off -> on with NO restoreTarget yet is a fresh launch (plan.kind === 'fresh')", () => {
    const state = storeWith(makeAgent({ id: "@a1", state: "off", restoreTarget: undefined }));
    const decision = decideOn(state, byId("@a1"));
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.wasOff).toBe(true);
      expect(decision.plan).toEqual({ kind: "fresh" });
    }
  });
});

// --- off: on -> off, refused while archived (this story's interpretation), no-change ---

describe("decideOff", () => {
  test("refused while archived (interpretation call: symmetric with on-while-archived)", () => {
    const state = storeWith(makeAgent({ id: "@a1", state: "archived" }));
    const decision = decideOff(state, byId("@a1"));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("archived");
  });

  test("no-change: already off", () => {
    const state = storeWith(makeAgent({ id: "@a1", state: "off" }));
    const decision = decideOff(state, byId("@a1"));
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.kind).toBe("no-change");
  });

  test("CONTROL: on -> off captures the live session id to stop", () => {
    const state = storeWith(makeAgent({ id: "@a1", state: "on", restoreTarget: { sessionId: "live-1", shortId: "live-1s" } }));
    const decision = decideOff(state, byId("@a1"));
    expect(decision.ok).toBe(true);
    if (decision.ok && decision.kind === "turn-off") {
      expect(decision.agent.state).toBe("off");
      expect(decision.restoreSessionId).toBe("live-1");
    } else {
      throw new Error("expected turn-off");
    }
  });

  test("on -> off with no live session yet reports restoreSessionId undefined (nothing to stop)", () => {
    const state = storeWith(makeAgent({ id: "@a1", state: "on", restoreTarget: undefined }));
    const decision = decideOff(state, byId("@a1"));
    expect(decision.ok).toBe(true);
    if (decision.ok && decision.kind === "turn-off") {
      expect(decision.restoreSessionId).toBeUndefined();
    } else {
      throw new Error("expected turn-off");
    }
  });
});

// --- archive: {on, off} -> archived, keeping the name, no-change on the diagonal ---

describe("decideArchive", () => {
  test("no-change: already archived", () => {
    const state = storeWith(makeAgent({ id: "@a1", state: "archived", name: "keepme" }));
    const decision = decideArchive(state, byId("@a1"));
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.kind).toBe("no-change");
      expect(decision.agent.name).toBe("keepme");
    }
  });

  test("CONTROL: on -> archived, keeping the name, capturing the session to stop", () => {
    const state = storeWith(makeAgent({ id: "@a1", state: "on", name: "keepme", restoreTarget: { sessionId: "live-1", shortId: "live-1s" } }));
    const decision = decideArchive(state, byId("@a1"));
    expect(decision.ok).toBe(true);
    if (decision.ok && decision.kind === "archive") {
      expect(decision.agent.state).toBe("archived");
      expect(decision.agent.name).toBe("keepme");
      expect(decision.restoreSessionId).toBe("live-1");
    } else {
      throw new Error("expected archive");
    }
  });

  test("CONTROL: off -> archived is also permitted (archive is not on-only)", () => {
    const state = storeWith(makeAgent({ id: "@a1", state: "off" }));
    const decision = decideArchive(state, byId("@a1"));
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.kind).toBe("archive");
  });
});

// --- unarchive: archived -> off, NEVER on; refused for anything not archived ---

describe("decideUnarchive", () => {
  test("refused: not archived (on)", () => {
    const state = storeWith(makeAgent({ id: "@a1", state: "on" }));
    const decision = decideUnarchive(state, byId("@a1"));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("not-archived");
  });

  test("refused: not archived (off)", () => {
    const state = storeWith(makeAgent({ id: "@a1", state: "off" }));
    const decision = decideUnarchive(state, byId("@a1"));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("not-archived");
  });

  test("CONTROL: archived -> off, never on", () => {
    const state = storeWith(makeAgent({ id: "@a1", state: "archived" }));
    const decision = decideUnarchive(state, byId("@a1"));
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.agent.state).toBe("off");
  });
});

// --- name / rename: RETIRED (R9) — an agent's name is always derived from
// its directory now; see agent-name.test.ts for derivation coverage and
// agent-model.test.ts's `resolveAgent` suite for the R8 rename hint.

// --- create: one non-archived agent per directory (R6) ---------------------

describe("decideCreate (R6)", () => {
  test("ok: an empty directory", () => {
    const decision = decideCreate(emptyAgentStore(), DIR_A);
    expect(decision.ok).toBe(true);
  });

  test("refused: a non-archived agent already exists for this directory", () => {
    const state = storeWith(makeAgent({ id: "@a1", directory: DIR_A, state: "on" }));
    const decision = decideCreate(state, DIR_A);
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe("directory-occupied");
      expect(decision.agent.id).toBe("@a1");
    }
  });

  test("CONTROL: an ARCHIVED agent in the directory does not block create", () => {
    const state = storeWith(makeAgent({ id: "@a1", directory: DIR_A, state: "archived" }));
    const decision = decideCreate(state, DIR_A);
    expect(decision.ok).toBe(true);
  });

  test("CONTROL: an agent in a DIFFERENT directory never blocks", () => {
    const state = storeWith(makeAgent({ id: "@a1", directory: DIR_B, state: "on" }));
    const decision = decideCreate(state, DIR_A);
    expect(decision.ok).toBe(true);
  });
});

// --- delete: any state -> permitted; not-found on an unknown/already-deleted ref ---

describe("decideDelete", () => {
  test("not-found on an unknown ref (double-delete naturally resolves here — no special-casing needed)", () => {
    const decision = decideDelete(emptyAgentStore(), byId("@unknown0000000000"));
    expect(decision.ok).toBe(false);
  });

  test("CONTROL: permitted for on/off/archived alike, carrying the live session id to stop", () => {
    for (const [lifecycleState, restoreSessionId] of [
      ["on", "live-1"],
      ["off", undefined],
      ["archived", undefined],
    ] as const) {
      const state = storeWith(makeAgent({ id: "@a1", state: lifecycleState, restoreTarget: restoreSessionId === undefined ? undefined : { sessionId: restoreSessionId, shortId: "live-1s" } }));
      const decision = decideDelete(state, byId("@a1"));
      expect(decision.ok).toBe(true);
      if (decision.ok) {
        expect(decision.agent.id).toBe("@a1");
        expect(decision.restoreSessionId).toBe(restoreSessionId);
      }
    }
  });
});

// --- attach target: a query; off/archived/not-yet-live refused distinctly ---

describe("decideAttachTarget", () => {
  test("refused: archived", () => {
    const state = storeWith(makeAgent({ id: "@a1", state: "archived" }));
    const decision = decideAttachTarget(state, byId("@a1"));
    expect(decision.ok).toBe(false);
    if (!decision.ok && "reason" in decision) expect(decision.reason).toBe("archived");
  });

  test("refused: off, with a message saying turning it on is the way — never silently started", () => {
    const state = storeWith(makeAgent({ id: "@a1", state: "off" }));
    const decision = decideAttachTarget(state, byId("@a1"));
    expect(decision.ok).toBe(false);
    if (!decision.ok && "reason" in decision) {
      expect(decision.reason).toBe("off");
      expect(decision.message.toLowerCase()).toContain("on");
    }
  });

  test("refused: on, but not yet live (launch hasn't resolved a session)", () => {
    const state = storeWith(makeAgent({ id: "@a1", state: "on", birthSessionId: undefined, restoreTarget: undefined }));
    const decision = decideAttachTarget(state, byId("@a1"));
    expect(decision.ok).toBe(false);
    if (!decision.ok && "reason" in decision) expect(decision.reason).toBe("not-yet-live");
  });

  test("CONTROL: on and live returns the session identity a caller needs, touching nothing else", () => {
    const state = storeWith(makeAgent({ id: "@a1", state: "on", birthSessionId: "durable-1", restoreTarget: { sessionId: "live-1", shortId: "live-1s" } }));
    const decision = decideAttachTarget(state, byId("@a1"));
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.restoreSessionId).toBe("live-1");
      expect(decision.birthSessionId).toBe("durable-1");
    }
  });
});
