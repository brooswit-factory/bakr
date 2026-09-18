import { describe, expect, test } from "bun:test";
import { emptyAgentStore, parseAgentStoreState, putAgent, serializeAgentStoreState, setAgentMcp, type AgentRecord } from "../../src/agent-model";
import type { ClaimKey } from "../../src/claim-key-resolve";

const agent: AgentRecord = {
  id: "@rocketr", name: "rocketr", directory: "/home/op/code/rocketr" as ClaimKey, state: "on",
  createdAt: 1, birthSessionId: undefined, restoreTarget: undefined,
};

const roundTrip = (json: string) => {
  const parsed = parseAgentStoreState(json);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.state;
};

describe("an agent's MCP declaration in the store", () => {
  test("round-trips", () => {
    const state = setAgentMcp(putAgent(emptyAgentStore(), agent), agent.id, [{ name: "rocketr", notifications: true }, { name: "yappr", notifications: false }]);
    expect(roundTrip(serializeAgentStoreState(state)).agents[agent.id]!.mcp).toEqual([{ name: "rocketr", notifications: true }, { name: "yappr", notifications: false }]);
  });

  test("an empty declaration is kept, distinct from none", () => {
    const state = setAgentMcp(putAgent(emptyAgentStore(), agent), agent.id, []);
    expect(roundTrip(serializeAgentStoreState(state)).agents[agent.id]!.mcp).toEqual([]);
  });

  test("an agent without one serializes exactly as before, so older builds read the store unchanged", () => {
    const json = serializeAgentStoreState(putAgent(emptyAgentStore(), agent));
    expect(json).not.toContain("mcp");
    expect("mcp" in roundTrip(json).agents[agent.id]!).toBe(false);
  });

  test("returning to the host default removes the field", () => {
    const declared = setAgentMcp(putAgent(emptyAgentStore(), agent), agent.id, [{ name: "yappr", notifications: true }]);
    const reset = setAgentMcp(declared, agent.id, undefined);
    expect("mcp" in reset.agents[agent.id]!).toBe(false);
    expect(serializeAgentStoreState(reset)).not.toContain("mcp");
  });

  test.each([
    ["not an array", { name: "yappr", notifications: true }],
    ["an entry without notifications", [{ name: "yappr" }]],
    ["an entry with a non-string name", [{ name: 7, notifications: true }]],
  ])("a declaration that is %s makes the store malformed rather than guessed at", (_label, mcp) => {
    const json = JSON.parse(serializeAgentStoreState(putAgent(emptyAgentStore(), agent)));
    json.agents[agent.id].mcp = mcp;
    expect(parseAgentStoreState(JSON.stringify(json)).ok).toBe(false);
  });

  test("setting it on an unknown agent changes nothing", () => {
    const state = putAgent(emptyAgentStore(), agent);
    expect(setAgentMcp(state, "@nobody", [])).toBe(state);
  });
});
