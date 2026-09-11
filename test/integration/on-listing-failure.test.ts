// BAKR-23's direct question, answered concretely: what does `on()` do
// when its up-front `claude agents --json` listing THROWS? Answer,
// PROVEN here rather than asserted: it propagates the failure as a typed
// refusal (`{ ok: false, reason: "listing-failed" }`) and NEVER reaches
// the lock, the decision, or `respawnSession` — possibility 1 from the
// epic's own list. Includes a positive control so a passing "never
// called" assertion cannot be trusted blind.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyAgentStore, putAgent, type AgentRecord } from "../../src/agent-model";
import { save as saveAgents } from "../../src/agent-store-io";
import { on, type AgentActionDeps } from "../../src/agent-actions";
import type { ClaimKey } from "../../src/claim-key-resolve";
import type { RunCommand } from "../../src/spawn";

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

describe("on() when the up-front listing THROWS (BAKR-23's direct question)", () => {
  test("propagates a typed listing-failed refusal — NEVER reaches respawnSession or launch", async () => {
    const dir = await makeTempDir();
    let state = emptyAgentStore();
    state = putAgent(state, agentWithRestoreTarget());
    await saveAgents(join(dir, "agents.json"), state);

    let respawnOrLaunchCalled = false;
    let listingCalled = false;
    const runCommand: RunCommand = async (argv) => {
      if (argv[0] === "claude" && argv[1] === "agents") {
        listingCalled = true;
        throw new Error("ECONNRESET: the claude daemon socket closed unexpectedly");
      }
      if ((argv[0] === "claude" && argv[1] === "respawn") || argv[0] === "systemd-run") {
        respawnOrLaunchCalled = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected command: ${JSON.stringify(argv)}`);
    };

    let counter = 0;
    const deps: AgentActionDeps = {
      agentsPath: join(dir, "agents.json"),
      runCommand,
      now: () => 1_700_000_000_000,
      generateAttemptId: () => `attempt-${counter++}`,
      randomBytes: (n) => new Uint8Array(n).fill(1),
    };

    const result = await on(deps, KEY, AGENT_ID);

    expect(listingCalled).toBe(true); // the instrument fired — this isn't a vacuous "never called anything"
    expect(respawnOrLaunchCalled).toBe(false);
    expect(result).toEqual({ ok: false, reason: "listing-failed", message: expect.stringContaining("ECONNRESET") });
  });

  test("POSITIVE CONTROL: when the listing succeeds and reports the session genuinely absent, on() DOES reach respawnSession — the refusal above is not because respawn is unreachable from on() in general", async () => {
    const dir = await makeTempDir();
    let state = emptyAgentStore();
    state = putAgent(state, agentWithRestoreTarget());
    await saveAgents(join(dir, "agents.json"), state);

    let respawnCalled = false;
    const runCommand: RunCommand = async (argv) => {
      if (argv[0] === "claude" && argv[1] === "agents") return { exitCode: 0, stdout: "[]", stderr: "" };
      if (argv[0] === "claude" && argv[1] === "respawn") {
        respawnCalled = true;
        return { exitCode: 0, stdout: "respawned\n", stderr: "" };
      }
      throw new Error(`unexpected command: ${JSON.stringify(argv)}`);
    };

    let counter = 0;
    const deps: AgentActionDeps = {
      agentsPath: join(dir, "agents.json"),
      runCommand,
      now: () => 1_700_000_000_000,
      generateAttemptId: () => `attempt-${counter++}`,
      randomBytes: (n) => new Uint8Array(n).fill(1),
    };

    const result = await on(deps, KEY, AGENT_ID);
    expect(result.ok).toBe(true);
    expect(respawnCalled).toBe(true);
  });
});
