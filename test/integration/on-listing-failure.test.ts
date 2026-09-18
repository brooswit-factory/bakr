// BAKR-23's direct question, answered concretely: what does `on()` do
// when its up-front session listing (herdr panes plus legacy `claude agents
// --json`) THROWS? Answer, PROVEN here rather than asserted: it propagates
// the failure as a typed refusal (`{ ok: false, reason: "listing-failed" }`)
// and NEVER reaches the lock, the decision, or `respawnSession` — possibility
// 1 from the epic's own list. Includes a positive control so a passing
// "never called" assertion cannot be trusted blind.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyAgentStore, putAgent, type AgentRecord } from "../../src/agent-model";
import { save as saveAgents } from "../../src/agent-store-io";
import { on, type AgentActionDeps } from "../../src/agent-actions";
import type { ClaimKey } from "../../src/claim-key-resolve";
import { makeFakeHost, type FakeHost } from "../support/fake-host";

const KEY = "/claimed/dir" as ClaimKey;
const AGENT_ID = "@on-listing-fail-agent";

const cleanupDirs: string[] = [];
afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});
async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bakr-on-listing-fail-test-"));
  cleanupDirs.push(dir);
  return dir;
}

function agentWithRestoreTarget(): AgentRecord {
  return { id: AGENT_ID, name: undefined, directory: KEY, state: "off", createdAt: 1, birthSessionId: "birth", restoreTarget: { sessionId: "session-uuid", shortId: "short001" } };
}

function depsFor(dir: string, host: FakeHost): AgentActionDeps {
  let counter = 0;
  return {
    agentsPath: join(dir, "agents.json"),
    runCommand: host.runCommand,
    now: () => 1_700_000_000_000,
    generateAttemptId: () => `attempt-${counter++}`,
    randomBytes: (n) => new Uint8Array(n).fill(1),
  };
}

const workspaceCreates = (host: FakeHost): string[][] => host.calls.filter((c) => c[0] === "herdr" && c[1] === "workspace" && c[2] === "create");

describe("on() when the up-front listing THROWS (BAKR-23's direct question)", () => {
  test("propagates a typed listing-failed refusal — NEVER reaches respawnSession or launch", async () => {
    const dir = await makeTempDir();
    await saveAgents(join(dir, "agents.json"), putAgent(emptyAgentStore(), agentWithRestoreTarget()));
    const host = makeFakeHost({ failListing: true });

    const result = await on(depsFor(dir, host), KEY, AGENT_ID);

    const listingCalled = host.calls.some((c) => c[0] === "herdr" && c[1] === "agent" && c[2] === "list");
    expect(listingCalled).toBe(true); // the instrument fired — this isn't a vacuous "never called anything"
    // Neither a restore (a `--resume` in a new pane) nor a fresh launch: no pane created, no claude started.
    expect(workspaceCreates(host)).toEqual([]);
    expect(host.starts()).toEqual([]);
    expect(result).toEqual({ ok: false, reason: "listing-failed", message: expect.stringContaining("simulated listing failure") });
  });

  test("POSITIVE CONTROL: when the listing succeeds and reports the session genuinely absent, on() DOES reach respawnSession — the refusal above is not because respawn is unreachable from on() in general", async () => {
    const dir = await makeTempDir();
    await saveAgents(join(dir, "agents.json"), putAgent(emptyAgentStore(), agentWithRestoreTarget()));
    const host = makeFakeHost();

    const result = await on(depsFor(dir, host), KEY, AGENT_ID);
    expect(result.ok).toBe(true);
    // The restore: the agent's own session resumed in a new pane.
    expect(host.starts().map((args) => args.slice(0, 2))).toEqual([["--resume", "session-uuid"]]);
  });
});
