// BAKR-48: one test per `problem.code`, plus the three whole-report shapes
// the consumer (lead-factory-dashboard) named as hard requirements — a
// herdr-read failure, a store-read failure, and a healthy host — decided
// against the pure model so each verdict is pinned to the exact inputs that
// produce it. The end-to-end proof that the real command produces these from a
// real fake host is in test/integration/status.test.ts.
//
// THE FALSIFIER lives at the bottom: "couldn't check" must not be "down".

import { describe, expect, test } from "bun:test";
import { emptyAgentStore, putAgent, type AgentRecord, type AgentStoreState, type LaunchRecord } from "../../src/agent-model";
import type { ClaimKey } from "../../src/claim-key-resolve";
import { buildStatusReport, statusExitCode, renderStatusText, type HerdrPane, type BlockingPromptInfo, type StatusInputs } from "../../src/status-model";

const KEY = "/claimed/dir" as ClaimKey;
const CHECKED_AT = 1_700_000_000_000;

function agent(over: Partial<AgentRecord> & { id: string }): AgentRecord {
  return {
    name: undefined, directory: KEY, state: "on", createdAt: 1, birthSessionId: "birth",
    restoreTarget: { sessionId: `${over.id}-session`, shortId: `${over.id}-pane` },
    ...over,
  };
}

function pane(over: Partial<HerdrPane> & { paneId: string; sessionId: string }): HerdrPane {
  return { cwd: KEY, herdrStatus: "idle", ...over };
}

function storeOf(...agents: AgentRecord[]): AgentStoreState {
  return agents.reduce((state, a) => putAgent(state, a), emptyAgentStore());
}

function report(over: { agents?: AgentRecord[]; panes?: HerdrPane[]; prompts?: BlockingPromptInfo[]; launches?: LaunchRecord[]; herdr?: StatusInputs["herdr"]; store?: StatusInputs["store"]; superseded?: (r: LaunchRecord) => boolean }) {
  const state = { ...storeOf(...(over.agents ?? [])), launches: over.launches ?? [] };
  return buildStatusReport({
    checkedAt: CHECKED_AT,
    herdr: over.herdr ?? { ok: true, panes: over.panes ?? [], prompts: over.prompts ?? [] },
    store: over.store ?? { ok: true, state },
    isSuperseded: over.superseded ?? (() => false),
  });
}

const failedLaunch = (over: Partial<LaunchRecord> & { agentId: string }): LaunchRecord => ({
  attemptId: "attempt-1", key: KEY, attemptKey: undefined, attemptedAt: CHECKED_AT - 60_000, launchShortId: undefined, error: "boom", ...over,
});

const only = (r: ReturnType<typeof report>) => r.agents[0]!;

describe("bakr status: each problem.code", () => {
  test("healthy: exactly one pane runs the session, and it is the recorded pane", () => {
    const a = agent({ id: "@a" });
    const r = report({ agents: [a], panes: [pane({ paneId: "@a-pane", sessionId: "@a-session", herdrStatus: "working" })] });
    expect(only(r)).toMatchObject({ id: "@a", state: "on", pane: "@a-pane", sessionId: "@a-session", herdrStatus: "working", blockedOn: null, ok: true, problem: null });
    expect(statusExitCode(r)).toBe(0);
    expect(r.duplicates).toEqual([]);
    expect(r.orphanPanes).toEqual([]);
    expect(r.unresolvedLaunches).toEqual([]);
    expect(r.blockedPrompts).toEqual([]);
    expect(r.checkedAt).toBe(new Date(CHECKED_AT).toISOString());
    expect(r.version).toBe(1);
  });

  test("not-in-herdr: nothing runs its session and nothing explains why", () => {
    const r = report({ agents: [agent({ id: "@a" })], panes: [] });
    expect(only(r)).toMatchObject({ ok: false, pane: "@a-pane", problem: { code: "not-in-herdr" } });
    expect(only(r).problem!.text).toContain("@a-session");
    expect(statusExitCode(r)).toBe(1);
  });

  test("wrong-session: its recorded pane runs somebody else's session, and its own runs nowhere", () => {
    const r = report({ agents: [agent({ id: "@a" })], panes: [pane({ paneId: "@a-pane", sessionId: "a-stranger" })] });
    expect(only(r)).toMatchObject({ ok: false, pane: "@a-pane", problem: { code: "wrong-session" } });
    expect(only(r).problem!.text).toContain("a-stranger");
  });

  test("wrong-pane: its session runs, in a pane bakr does not have recorded", () => {
    const r = report({ agents: [agent({ id: "@a" })], panes: [pane({ paneId: "w9:p1", sessionId: "@a-session" })] });
    expect(only(r)).toMatchObject({ ok: false, pane: "w9:p1", problem: { code: "wrong-pane" } });
    expect(only(r).problem!.text).toContain("@a-pane");
  });

  test("duplicate-session: one session, two panes — the incident this ticket was opened for", () => {
    const r = report({
      agents: [agent({ id: "@a", name: "lead-dynamic-atmosphere" })],
      panes: [pane({ paneId: "@a-pane", sessionId: "@a-session" }), pane({ paneId: "w7:p1", sessionId: "@a-session" })],
    });
    expect(only(r)).toMatchObject({ ok: false, name: "lead-dynamic-atmosphere", problem: { code: "duplicate-session" } });
    expect(r.duplicates).toEqual([{ sessionId: "@a-session", panes: ["@a-pane", "w7:p1"] }]);
    expect(statusExitCode(r)).toBe(1);
  });

  test("restore-refused: an unresolved launch record for an on agent that is not running (BAKR-33)", () => {
    const r = report({
      agents: [agent({ id: "@a", name: "yappr-3" })],
      panes: [],
      launches: [failedLaunch({ agentId: "@a", attemptId: "attempt-33", error: "registered cwd is stale" })],
    });
    expect(only(r)).toMatchObject({ ok: false, problem: { code: "restore-refused" } });
    expect(only(r).problem!.text).toContain("attempt-33");
    expect(r.unresolvedLaunches).toEqual([{ agentId: "@a", attemptId: "attempt-33", attemptedAt: new Date(CHECKED_AT - 60_000).toISOString(), error: "registered cwd is stale" }]);
  });

  test("blocked: alive, in its own pane, waiting on a dialog", () => {
    const prompts: BlockingPromptInfo[] = [{ paneId: "@a-pane", sessionId: "@a-session", herdrStatus: "idle", kind: "permission", name: "Bash", excerpt: "Do you want to proceed?" }];
    const r = report({ agents: [agent({ id: "@a" })], panes: [pane({ paneId: "@a-pane", sessionId: "@a-session" })], prompts });
    expect(only(r)).toMatchObject({ ok: false, blockedOn: "permission", problem: { code: "blocked" } });
    expect(r.blockedPrompts).toEqual([{ pane: "@a-pane", agentId: "@a", kind: "permission", name: "Bash", excerpt: "Do you want to proceed?" }]);
  });

  test("a superseded stale-cwd refusal is neither an unresolved launch nor a restore-refused problem", () => {
    const r = report({
      agents: [agent({ id: "@a" })],
      panes: [pane({ paneId: "@a-pane", sessionId: "@a-session" })],
      launches: [failedLaunch({ agentId: "@a" })],
      superseded: () => true,
    });
    expect(r.unresolvedLaunches).toEqual([]);
    expect(only(r)).toMatchObject({ ok: true, problem: null });
  });

  test("an on agent that has never resolved a session is down, and a launch still in flight is said so in words", () => {
    const never = report({ agents: [agent({ id: "@a", restoreTarget: undefined })] });
    expect(only(never)).toMatchObject({ ok: false, pane: null, sessionId: null, problem: { code: "not-in-herdr" } });
    const flying = report({
      agents: [agent({ id: "@a", restoreTarget: undefined })],
      launches: [{ ...failedLaunch({ agentId: "@a", attemptId: "in-flight" }), error: undefined }],
    });
    expect(only(flying).problem!.text).toContain("in-flight");
    expect(flying.unresolvedLaunches).toEqual([]);
  });
});

describe("bakr status: whole-report shapes", () => {
  test("off and archived agents are listed with ok: null and no problem, even when their session is running", () => {
    const r = report({
      agents: [agent({ id: "@off", state: "off" }), agent({ id: "@arch", state: "archived" })],
      panes: [pane({ paneId: "@off-pane", sessionId: "@off-session", herdrStatus: "working" })],
    });
    expect(r.agents.map((a) => ({ id: a.id, ok: a.ok, problem: a.problem }))).toEqual([
      { id: "@arch", ok: null, problem: null },
      { id: "@off", ok: null, problem: null },
    ]);
    expect(r.agents.find((a) => a.id === "@off")!.herdrStatus).toBe("working");
    expect(statusExitCode(r)).toBe(0);
  });

  test("orphanPanes: a Claude pane whose session belongs to no on agent — including an off agent's", () => {
    const r = report({
      agents: [agent({ id: "@a" }), agent({ id: "@off", state: "off" })],
      panes: [pane({ paneId: "@a-pane", sessionId: "@a-session" }), pane({ paneId: "@off-pane", sessionId: "@off-session" }), pane({ paneId: "w9:p1", sessionId: "someone-else" })],
    });
    expect(r.orphanPanes).toEqual([{ pane: "@off-pane", sessionId: "@off-session" }, { pane: "w9:p1", sessionId: "someone-else" }]);
    // Panes bakr does not own are context, not bakr's own ill health.
    expect(statusExitCode(r)).toBe(0);
  });

  test("a blocked prompt on a pane belonging to no bakr agent is reported with agentId null", () => {
    const r = report({
      panes: [pane({ paneId: "w9:p1", sessionId: "someone-else" })],
      prompts: [{ paneId: "w9:p1", sessionId: "someone-else", herdrStatus: "idle", kind: "unknown", name: undefined, excerpt: "Enter to confirm" }],
    });
    expect(r.blockedPrompts).toEqual([{ pane: "w9:p1", agentId: null, kind: "unknown", name: null, excerpt: "Enter to confirm" }]);
    expect(statusExitCode(r)).toBe(0);
  });

  test("a store-read failure reports itself and invents no agents", () => {
    const r = report({ store: { ok: false, reason: "agents.json is malformed" }, panes: [pane({ paneId: "w9:p1", sessionId: "s" })] });
    expect(r.store).toEqual({ ok: false, reason: "agents.json is malformed" });
    expect(r.herdr).toEqual({ ok: true });
    expect(r.agents).toEqual([]);
    expect(r.unresolvedLaunches).toEqual([]);
    // With no store there is nothing for a pane to be orphaned FROM, so no pane is called one.
    expect(r.orphanPanes).toEqual([]);
    expect(statusExitCode(r)).toBe(2);
  });

  test("the human summary carries the same findings as the JSON", () => {
    const text = renderStatusText(report({
      agents: [agent({ id: "@a", name: "yappr-3" })],
      panes: [],
      launches: [failedLaunch({ agentId: "@a", attemptId: "attempt-33" })],
    }));
    expect(text).toContain("@a");
    expect(text).toContain("yappr-3");
    expect(text).toContain("restore-refused");
    expect(text).toContain("unresolved launch attempt-33");
  });
});

// --- THE FALSIFIER ------------------------------------------------------
//
// Hard requirement 2 from the consumer: "Couldn't check" is not "down". With
// the "couldn't check" handling removed from buildStatusReport — that is, with
// a failed herdr read treated as an empty listing — every agent below would
// come out `ok: false` with `not-in-herdr`, and this test fails on all four
// of its assertions at once.
test("FALSIFIER: a failed herdr listing leaves every agent ok: null, never not-in-herdr", () => {
  const r = report({
    agents: [agent({ id: "@a" }), agent({ id: "@b" })],
    herdr: { ok: false, reason: "`herdr agent list` failed: connection refused" },
  });
  expect(r.herdr).toEqual({ ok: false, reason: "`herdr agent list` failed: connection refused" });
  expect(r.agents.map((a) => a.ok)).toEqual([null, null]);
  expect(r.agents.map((a) => a.problem)).toEqual([null, null]);
  expect(r.agents.map((a) => a.blockedOn)).toEqual([null, null]);
  expect(r.agents.every((a) => a.pane === null && a.herdrStatus === null)).toBe(true);
  expect(statusExitCode(r)).toBe(2);
});

test("exit 2 wins over exit 1: a report that could not see everything is never a clean bill of health", () => {
  const r = report({ agents: [agent({ id: "@a" })], herdr: { ok: false, reason: "down" }, store: { ok: false, reason: "malformed" } });
  expect(statusExitCode(r)).toBe(2);
});
