import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyAgentStore, putAgent, type AgentRecord } from "../../src/agent-model";
import { save as saveAgents } from "../../src/agent-store-io";
import type { ClaimKey } from "../../src/claim-key-resolve";
import { runCli, type CliDeps } from "../../src/cli/main";
import type { ResidentMessenger, ResidentTarget } from "../../src/cli/send";
import { realOrphanProbeDeps, realResolveInputs } from "../../src/paths";

const dirs: string[] = [];
afterEach(async () => { while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true }); });

function refusal(reason: string): Error {
  return Object.assign(new Error(`${reason} detail`), { name: "ResidentMessageRefusal", reason });
}

async function setup(agent: Partial<AgentRecord>, send: ResidentMessenger["message"]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bakr-cli-send-")));
  dirs.push(root);
  const agentsPath = join(root, "agents.json");
  await saveAgents(agentsPath, putAgent(emptyAgentStore(), {
    id: "@a1", name: "alice", directory: root as ClaimKey, state: "on", createdAt: 1,
    birthSessionId: "full-session", restoreTarget: { sessionId: "full-session", shortId: "fullsess" }, ...agent,
  }));
  const out: string[] = [], err: string[] = [], sent: [ResidentTarget, string][] = [];
  const deps: CliDeps = {
    actions: { agentsPath, runCommand: async () => { throw new Error("send must not run claude itself"); }, now: () => 1, generateAttemptId: () => "x", randomBytes: n => new Uint8Array(n) },
    adopt: {} as CliDeps["adopt"], claimsPath: join(root, "claims.json"), resolveInputs: realResolveInputs, probeDeps: realOrphanProbeDeps,
    cwd: root, home: root, stdinIsTTY: false, stdoutIsTTY: false,
    stdout: s => { out.push(s); }, stderr: s => { err.push(s); },
    prompt: async () => { throw new Error("must not prompt"); }, spawnAttach: async () => { throw new Error("must not attach"); },
    messenger: { message: async (target, text) => { sent.push([target, text]); return send(target, text); } },
  };
  return { root, deps, out, err, sent };
}

test("send targets the agent's current session and prints the reply without a TTY", async () => {
  const s = await setup({}, async () => ({ status: "replied", reply: "done" }));
  expect(await runCli(["alice", "send", "status?"], s.deps)).toBe(0);
  expect(s.sent).toEqual([[{ provider: "claude", sessionId: "full-session", cwd: s.root }, "status?"]]);
  expect(s.out.join("")).toBe("done\n");
  expect(s.err).toEqual([]);
});

test("a pending reply is delivered but reported as unfinished", async () => {
  const s = await setup({}, async () => ({ status: "reply-pending", reply: "partial" }));
  expect(await runCli(["@a1", "send", "status?"], s.deps)).toBe(1);
  expect(s.out.join("")).toBe("partial\n");
  expect(s.err.join("")).toContain("reply-pending: delivered to agent @a1");
});

test.each([["busy", 1], ["not-running", 1], ["unsupported-provider", 1], ["delivery-unconfirmed", 3]] as const)(
  "transport refusal %s is reported, never retried", async (reason, code) => {
    const s = await setup({}, async () => { throw refusal(reason); });
    expect(await runCli(["alice", "send", "hi"], s.deps)).toBe(code);
    expect(s.sent.length).toBe(1);
    expect(s.err.join("")).toBe(`${reason}: ${reason} detail\n`);
  });

test("an off agent is refused before any transport call", async () => {
  const s = await setup({ state: "off" }, async () => { throw new Error("must not send"); });
  expect(await runCli(["alice", "send", "hi"], s.deps)).toBe(1);
  expect(s.sent).toEqual([]);
});
