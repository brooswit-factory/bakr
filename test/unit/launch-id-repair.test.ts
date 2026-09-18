import { describe, expect, test } from "bun:test";
import { parseAgentStoreState, resolveLaunch, serializeAgentStoreState } from "../../src/agent-model";
import { plainOutputEnv } from "../../src/spawn/exec";
import { parseLaunchId, stripAnsi } from "../../src/spawn/parse";

// The exact bytes `claude --bg` printed, and bakr recorded, when `bakr create`
// ran from inside a Claude Code session (FORCE_COLOR=3 in its environment).
const COLOURED_ID = "[36m52155a5f[39m[2m";
const COLOURED_STDOUT = `backgrounded · ${COLOURED_ID} (idle — send a prompt to start)[22m\n`;

describe("a launch id printed in colour", () => {
  test("parses to the bare short id", () => {
    expect(parseLaunchId(COLOURED_STDOUT)).toBe("52155a5f");
  });

  test("an id that is nothing but escapes is refused, not recorded", () => {
    expect(() => parseLaunchId("backgrounded · [36m[39m (idle)\n")).toThrow();
  });

  test("stripAnsi removes colour and hyperlink sequences and nothing else", () => {
    expect(stripAnsi(`a${COLOURED_ID}b`)).toBe("a52155a5fb");
    expect(stripAnsi("]8;;https://xlink]8;; · plain")).toBe("link · plain");
  });
});

describe("colour is not forced on anything bakr parses", () => {
  test("FORCE_COLOR is dropped and nothing else changes", () => {
    const env = { FORCE_COLOR: "3", PATH: "/usr/bin", TERM: "xterm-256color" };
    expect(plainOutputEnv(env)).toEqual({ PATH: "/usr/bin", TERM: "xterm-256color" });
    expect(env.FORCE_COLOR).toBe("3");
  });
});

describe("a store written before the fix", () => {
  const AGENT = "@3jaezjgefm5rjrrjd4";
  const DIR = "/home/op/code/rocketr";
  const store = JSON.stringify({
    version: 2,
    agents: {
      [AGENT]: { id: AGENT, name: "rocketr", directory: DIR, state: "on", createdAt: 1789695702598, birthSessionId: null, restoreTarget: null },
    },
    retiredIds: [],
    launches: [
      { attemptId: "411d52cd-6a64-40a1-bb29-106da60a7038", agentId: AGENT, key: DIR, attemptKey: null, attemptedAt: 1789695702598, launchShortId: COLOURED_ID, error: null },
    ],
    pendingCreations: [{ attemptId: "p1", key: DIR, launchShortId: COLOURED_ID, attemptedAt: 1789695702598 }],
    restoreAttemptCounts: {},
  });

  test("loads with the recorded ids repaired", () => {
    const parsed = parseAgentStoreState(store);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.state.launches[0]!.launchShortId).toBe("52155a5f");
    expect(parsed.state.pendingCreations[0]!.launchShortId).toBe("52155a5f");
  });

  test("the repaired launch resolves against the listing and gives its agent a session", () => {
    const parsed = parseAgentStoreState(store);
    if (!parsed.ok) throw new Error(parsed.error);
    const sessionId = "52155a5f-5660-41f3-b9c6-6ff307e3c6ad";
    const resolved = resolveLaunch(parsed.state, "52155a5f", sessionId);
    expect(resolved.agents[AGENT]!.restoreTarget).toEqual({ sessionId, shortId: "52155a5f" });
    expect(resolved.agents[AGENT]!.birthSessionId).toBe(sessionId);
  });

  test("saving writes the clean id back", () => {
    const parsed = parseAgentStoreState(store);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(serializeAgentStoreState(parsed.state)).not.toContain("\\u001b");
  });
});
