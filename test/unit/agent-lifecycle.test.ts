// DoD item 3: the pure transition table, unit-tested exhaustively — every
// refusal and every "no change" case, each WITH a control proving a
// permitted transition through the same decision function still passes (a
// table that refuses everything would pass a test that only checks
// refusals). No filesystem, no lock, no spawn substrate anywhere in this
// file — everything here is a pure function of a store snapshot.

import { describe, expect, test } from "bun:test";
import { type AgentRecord, emptyAgentStore, putAgent, type AgentStoreState } from "../../src/agent-model";
import {
  decideArchive,
  decideAttachTarget,
  decideCreateName,
  decideDelete,
  decideName,
  decideOff,
  decideOn,
  decideRename,
  decideUnarchive,
} from "../../src/agent-lifecycle";
import type { ClaimKey } from "../../src/claim-key-resolve";

const DIR_A = "/home/alice/project" as ClaimKey;
const DIR_B = "/home/alice/other" as ClaimKey;

function makeAgent(overrides: Partial<AgentRecord> & { id: string }): AgentRecord {
  return {
    name: undefined,
    directory: DIR_A,
    state: "on",
    createdAt: 1000,
    durableSessionId: undefined,
    liveSessionId: undefined,
    ...overrides,
  };
}

function storeWith(...agents: AgentRecord[]): AgentStoreState {
  let state = emptyAgentStore();
  for (const agent of agents) state = putAgent(state, agent);
  return state;
}

// --- Shared resolution: not-found / found-elsewhere, exercised through every verb ---

describe("resolution, shared by every verb", () => {
  test("not-found: unknown id", () => {
    const state = storeWith(makeAgent({ id: "@a1" }));
    const decision = decideOn(state, DIR_A, "@doesnotexist00000");
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("not-found");
  });

  test("not-found: unknown name", () => {
    const state = storeWith(makeAgent({ id: "@a1", name: "real" }));
    const decision = decideOn(state, DIR_A, "notreal");
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("not-found");
  });

  test("not-found message names the id as deleted when it is in retiredIds (delete's own note)", () => {
    const state = { ...emptyAgentStore(), retiredIds: ["@retired00000000000"] };
    const decision = decideOn(state, DIR_A, "@retired00000000000");
    expect(decision.ok).toBe(false);
    if (!decision.ok && decision.reason === "not-found") {
      expect(decision.message).toContain("deleted");
    } else {
      throw new Error("expected not-found");
    }
  });

  test("found-elsewhere: an id exists, but in a different directory — NOT flattened into not-found", () => {
    const state = storeWith(makeAgent({ id: "@a1", directory: DIR_B }));
    const decision = decideOn(state, DIR_A, "@a1");
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe("found-elsewhere");
      if (decision.reason === "found-elsewhere") expect(decision.directory).toBe(DIR_B);
    }
  });

  test("a name never resolves outside its own directory scope (not found-elsewhere, genuinely not-found)", () => {
    const state = storeWith(makeAgent({ id: "@a1", name: "bob", directory: DIR_B }));
    const decision = decideOn(state, DIR_A, "bob");
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("not-found");
  });

  test("CONTROL: a real, in-scope id resolves", () => {
    const state = storeWith(makeAgent({ id: "@a1", state: "off" }));
    const decision = decideOn(state, DIR_A, "@a1");
    expect(decision.ok).toBe(true);
  });
});

// --- on: off -> on, refused while archived, no-change on the diagonal ---

describe("decideOn", () => {
  test("refused while archived — never a silent unarchive", () => {
    const state = storeWith(makeAgent({ id: "@a1", state: "archived" }));
    const decision = decideOn(state, DIR_A, "@a1");
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("archived");
  });

  test("already on: wasOff is false, agent unchanged (the launch-record wedge check is agent-actions.ts's job, not this pure function's)", () => {
    const state = storeWith(makeAgent({ id: "@a1", state: "on", durableSessionId: "sess-1" }));
    const decision = decideOn(state, DIR_A, "@a1");
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.wasOff).toBe(false);
      expect(decision.agent.state).toBe("on");
      expect(decision.priorSessionId).toBe("sess-1"); // still computed — agent-actions.ts's `on` needs it for the wedge check even when not transitioning
    }
  });

  test("CONTROL: off -> on with a durable session resumes that session id", () => {
    const state = storeWith(makeAgent({ id: "@a1", state: "off", durableSessionId: "sess-1" }));
    const decision = decideOn(state, DIR_A, "@a1");
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.wasOff).toBe(true);
      expect(decision.agent.state).toBe("on");
      expect(decision.priorSessionId).toBe("sess-1");
    }
  });

  test("off -> on with NO durable session yet is a fresh launch (priorSessionId undefined)", () => {
    const state = storeWith(makeAgent({ id: "@a1", state: "off", durableSessionId: undefined }));
    const decision = decideOn(state, DIR_A, "@a1");
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.wasOff).toBe(true);
      expect(decision.priorSessionId).toBeUndefined();
    }
  });
});

// --- off: on -> off, refused while archived (this story's interpretation), no-change ---

describe("decideOff", () => {
  test("refused while archived (interpretation call: symmetric with on-while-archived)", () => {
    const state = storeWith(makeAgent({ id: "@a1", state: "archived" }));
    const decision = decideOff(state, DIR_A, "@a1");
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("archived");
  });

  test("no-change: already off", () => {
    const state = storeWith(makeAgent({ id: "@a1", state: "off" }));
    const decision = decideOff(state, DIR_A, "@a1");
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.kind).toBe("no-change");
  });

  test("CONTROL: on -> off captures the live session id to stop", () => {
    const state = storeWith(makeAgent({ id: "@a1", state: "on", liveSessionId: "live-1" }));
    const decision = decideOff(state, DIR_A, "@a1");
    expect(decision.ok).toBe(true);
    if (decision.ok && decision.kind === "turn-off") {
      expect(decision.agent.state).toBe("off");
      expect(decision.liveSessionId).toBe("live-1");
    } else {
      throw new Error("expected turn-off");
    }
  });

  test("on -> off with no live session yet reports liveSessionId undefined (nothing to stop)", () => {
    const state = storeWith(makeAgent({ id: "@a1", state: "on", liveSessionId: undefined }));
    const decision = decideOff(state, DIR_A, "@a1");
    expect(decision.ok).toBe(true);
    if (decision.ok && decision.kind === "turn-off") {
      expect(decision.liveSessionId).toBeUndefined();
    } else {
      throw new Error("expected turn-off");
    }
  });
});

// --- archive: {on, off} -> archived, keeping the name, no-change on the diagonal ---

describe("decideArchive", () => {
  test("no-change: already archived", () => {
    const state = storeWith(makeAgent({ id: "@a1", state: "archived", name: "keepme" }));
    const decision = decideArchive(state, DIR_A, "@a1");
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.kind).toBe("no-change");
      expect(decision.agent.name).toBe("keepme");
    }
  });

  test("CONTROL: on -> archived, keeping the name, capturing the session to stop", () => {
    const state = storeWith(makeAgent({ id: "@a1", state: "on", name: "keepme", liveSessionId: "live-1" }));
    const decision = decideArchive(state, DIR_A, "@a1");
    expect(decision.ok).toBe(true);
    if (decision.ok && decision.kind === "archive") {
      expect(decision.agent.state).toBe("archived");
      expect(decision.agent.name).toBe("keepme");
      expect(decision.liveSessionId).toBe("live-1");
    } else {
      throw new Error("expected archive");
    }
  });

  test("CONTROL: off -> archived is also permitted (archive is not on-only)", () => {
    const state = storeWith(makeAgent({ id: "@a1", state: "off" }));
    const decision = decideArchive(state, DIR_A, "@a1");
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.kind).toBe("archive");
  });
});

// --- unarchive: archived -> off, NEVER on; refused for anything not archived ---

describe("decideUnarchive", () => {
  test("refused: not archived (on)", () => {
    const state = storeWith(makeAgent({ id: "@a1", state: "on" }));
    const decision = decideUnarchive(state, DIR_A, "@a1");
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("not-archived");
  });

  test("refused: not archived (off)", () => {
    const state = storeWith(makeAgent({ id: "@a1", state: "off" }));
    const decision = decideUnarchive(state, DIR_A, "@a1");
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("not-archived");
  });

  test("CONTROL: archived -> off, never on", () => {
    const state = storeWith(makeAgent({ id: "@a1", state: "archived" }));
    const decision = decideUnarchive(state, DIR_A, "@a1");
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.agent.state).toBe("off");
  });
});

// --- rename / name: one function; per-directory uniqueness incl. archived holders ---

describe("decideRename (and decideName — the SAME function)", () => {
  test("decideName is decideRename, not a second implementation", () => {
    expect(decideName).toBe(decideRename);
  });

  test("no-change: renaming to the name it already has", () => {
    const state = storeWith(makeAgent({ id: "@a1", name: "bob" }));
    const decision = decideRename(state, DIR_A, "@a1", "bob");
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.kind).toBe("no-change");
  });

  test("refused: empty name", () => {
    const state = storeWith(makeAgent({ id: "@a1" }));
    const decision = decideRename(state, DIR_A, "@a1", "");
    expect(decision.ok).toBe(false);
    if (!decision.ok && "reason" in decision) expect(decision.reason).toBe("empty");
  });

  test("refused: contains '@'", () => {
    const state = storeWith(makeAgent({ id: "@a1" }));
    const decision = decideRename(state, DIR_A, "@a1", "bo@b");
    expect(decision.ok).toBe(false);
    if (!decision.ok && "reason" in decision) expect(decision.reason).toBe("contains-at");
  });

  test("refused: a reserved word", () => {
    const state = storeWith(makeAgent({ id: "@a1" }));
    const decision = decideRename(state, DIR_A, "@a1", "archive");
    expect(decision.ok).toBe(false);
    if (!decision.ok && "reason" in decision) expect(decision.reason).toBe("reserved");
  });

  test("refused: taken by a live holder in the same directory", () => {
    const state = storeWith(makeAgent({ id: "@a1" }), makeAgent({ id: "@a2", name: "taken" }));
    const decision = decideRename(state, DIR_A, "@a1", "taken");
    expect(decision.ok).toBe(false);
    if (!decision.ok && "reason" in decision && decision.reason === "taken") {
      expect(decision.heldBy.id).toBe("@a2");
    } else {
      throw new Error("expected taken");
    }
  });

  test("refused: taken by an ARCHIVED holder (B4 — archived agents keep their name)", () => {
    const state = storeWith(makeAgent({ id: "@a1" }), makeAgent({ id: "@a2", name: "taken", state: "archived" }));
    const decision = decideRename(state, DIR_A, "@a1", "taken");
    expect(decision.ok).toBe(false);
    if (!decision.ok && "reason" in decision) expect(decision.reason).toBe("taken");
  });

  test("CONTROL: the same name is free in a DIFFERENT directory (B4: per-directory, not global)", () => {
    const state = storeWith(makeAgent({ id: "@a1", directory: DIR_A }), makeAgent({ id: "@a2", directory: DIR_B, name: "shared" }));
    const decision = decideRename(state, DIR_A, "@a1", "shared");
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.kind).toBe("renamed");
  });

  test("CONTROL: a valid, available new name succeeds regardless of lifecycle state (on/off/archived all permitted)", () => {
    for (const lifecycleState of ["on", "off", "archived"] as const) {
      const state = storeWith(makeAgent({ id: "@a1", state: lifecycleState }));
      const decision = decideRename(state, DIR_A, "@a1", "freshname");
      expect(decision.ok).toBe(true);
      if (decision.ok && decision.kind === "renamed") {
        expect(decision.agent.name).toBe("freshname");
        expect(decision.agent.state).toBe(lifecycleState); // rename moves nothing else (R16)
      } else {
        throw new Error("expected renamed");
      }
    }
  });

  test("R16: rename never touches `directory`", () => {
    const state = storeWith(makeAgent({ id: "@a1", directory: DIR_A }));
    const decision = decideRename(state, DIR_A, "@a1", "newname");
    expect(decision.ok).toBe(true);
    if (decision.ok && decision.kind === "renamed") expect(decision.agent.directory).toBe(DIR_A);
  });
});

// --- create: name validation only (the mint/launch is agent-actions.ts's job) ---

describe("decideCreateName", () => {
  test("ok: no name given (unnamed is a normal, supported state)", () => {
    const decision = decideCreateName(emptyAgentStore(), DIR_A, undefined);
    expect(decision.ok).toBe(true);
  });

  test("refused: empty / contains-at / reserved — same rules as rename", () => {
    expect(decideCreateName(emptyAgentStore(), DIR_A, "").ok).toBe(false);
    expect(decideCreateName(emptyAgentStore(), DIR_A, "a@b").ok).toBe(false);
    expect(decideCreateName(emptyAgentStore(), DIR_A, "list").ok).toBe(false);
  });

  test("refused: taken in this directory", () => {
    const state = storeWith(makeAgent({ id: "@a1", name: "taken" }));
    const decision = decideCreateName(state, DIR_A, "taken");
    expect(decision.ok).toBe(false);
  });

  test("CONTROL: an available name is accepted", () => {
    const decision = decideCreateName(emptyAgentStore(), DIR_A, "fresh");
    expect(decision.ok).toBe(true);
  });
});

// --- delete: any state -> permitted; not-found on an unknown/already-deleted ref ---

describe("decideDelete", () => {
  test("not-found on an unknown ref (double-delete naturally resolves here — no special-casing needed)", () => {
    const decision = decideDelete(emptyAgentStore(), DIR_A, "@unknown0000000000");
    expect(decision.ok).toBe(false);
  });

  test("CONTROL: permitted for on/off/archived alike, carrying the live session id to stop", () => {
    for (const [lifecycleState, liveSessionId] of [
      ["on", "live-1"],
      ["off", undefined],
      ["archived", undefined],
    ] as const) {
      const state = storeWith(makeAgent({ id: "@a1", state: lifecycleState, liveSessionId }));
      const decision = decideDelete(state, DIR_A, "@a1");
      expect(decision.ok).toBe(true);
      if (decision.ok) {
        expect(decision.agent.id).toBe("@a1");
        expect(decision.liveSessionId).toBe(liveSessionId);
      }
    }
  });
});

// --- attach target: a query; off/archived/not-yet-live refused distinctly ---

describe("decideAttachTarget", () => {
  test("refused: archived", () => {
    const state = storeWith(makeAgent({ id: "@a1", state: "archived" }));
    const decision = decideAttachTarget(state, DIR_A, "@a1");
    expect(decision.ok).toBe(false);
    if (!decision.ok && "reason" in decision) expect(decision.reason).toBe("archived");
  });

  test("refused: off, with a message saying turning it on is the way — never silently started", () => {
    const state = storeWith(makeAgent({ id: "@a1", state: "off" }));
    const decision = decideAttachTarget(state, DIR_A, "@a1");
    expect(decision.ok).toBe(false);
    if (!decision.ok && "reason" in decision) {
      expect(decision.reason).toBe("off");
      expect(decision.message.toLowerCase()).toContain("on");
    }
  });

  test("refused: on, but not yet live (launch hasn't resolved a session)", () => {
    const state = storeWith(makeAgent({ id: "@a1", state: "on", durableSessionId: undefined, liveSessionId: undefined }));
    const decision = decideAttachTarget(state, DIR_A, "@a1");
    expect(decision.ok).toBe(false);
    if (!decision.ok && "reason" in decision) expect(decision.reason).toBe("not-yet-live");
  });

  test("CONTROL: on and live returns the session identity a caller needs, touching nothing else", () => {
    const state = storeWith(makeAgent({ id: "@a1", state: "on", durableSessionId: "durable-1", liveSessionId: "live-1" }));
    const decision = decideAttachTarget(state, DIR_A, "@a1");
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.liveSessionId).toBe("live-1");
      expect(decision.durableSessionId).toBe("durable-1");
    }
  });
});
