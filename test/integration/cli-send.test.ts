import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyAgentStore, putAgent, type AgentRecord } from "../../src/agent-model";
import { load as loadAgents, save as saveAgents } from "../../src/agent-store-io";
import type { ClaimKey } from "../../src/claim-key-resolve";
import { runCli, type CliDeps } from "../../src/cli/main";
import type { ResidentMessenger, ResidentTarget } from "../../src/cli/send";
import { realOrphanProbeDeps, realResolveInputs } from "../../src/paths";

const dirs: string[] = [];
afterEach(async () => { while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true }); });

function refusal(reason: string): Error {
  return Object.assign(new Error(`${reason} detail`), { name: "ResidentMessageRefusal", reason });
}

type Listed = { sessionId: string; cwd: string; pid?: number };

async function setup(agent: Partial<AgentRecord>, send: ResidentMessenger["message"], listing?: (root: string) => Listed[] | Error) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bakr-cli-send-")));
  dirs.push(root);
  const agentsPath = join(root, "agents.json");
  await saveAgents(agentsPath, putAgent(emptyAgentStore(), {
    id: "@a1", name: "alice", directory: root as ClaimKey, state: "on", createdAt: 1,
    birthSessionId: "full-session", restoreTarget: { sessionId: "full-session", shortId: "fullsess" }, ...agent,
  }));
  const out: string[] = [], err: string[] = [], sent: [ResidentTarget, string][] = [], commands: string[][] = [];
  const listed = listing ?? (r => [{ sessionId: "full-session", cwd: r, pid: 1 }]);
  const deps: CliDeps = {
    actions: { agentsPath, runCommand: async argv => {
      commands.push(argv);
      // send only ever reads the listing — never launches, respawns, or stops a session itself.
      if (argv.join(" ") !== "claude agents --json") throw new Error(`send must not run ${argv.join(" ")}`);
      const l = listed(root);
      if (l instanceof Error) return { exitCode: 1, stdout: "", stderr: l.message };
      return { exitCode: 0, stderr: "", stdout: JSON.stringify(l.map(e => ({ kind: "background", id: e.sessionId.slice(0, 8), startedAt: 1, ...e }))) };
    }, now: () => 1, generateAttemptId: () => "x", randomBytes: n => new Uint8Array(n) },
    adopt: {} as CliDeps["adopt"], claimsPath: join(root, "claims.json"), resolveInputs: realResolveInputs, probeDeps: realOrphanProbeDeps,
    cwd: root, home: root, stdinIsTTY: false, stdoutIsTTY: false,
    stdout: s => { out.push(s); }, stderr: s => { err.push(s); },
    prompt: async () => { throw new Error("must not prompt"); }, spawnAttach: async () => { throw new Error("must not attach"); },
    messenger: { message: async (target, text) => { sent.push([target, text]); return send(target, text); } },
  };
  return { root, deps, out, err, sent, commands, agentsPath };
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

// Regression: after a reboot restore the Butchr resident was alive and idle,
// but running inside a worktree it had entered. `bakr list` matched the
// exact session id and said "listed by claude"; send handed the transport
// the agent directory, which matched no listed cwd, and was refused as
// not-running.
test("an agent whose session moved into a worktree under its directory is listed and sendable there", async () => {
  const s = await setup({}, async () => ({ status: "replied", reply: "done" }), r => [{ sessionId: "full-session", cwd: `${r}/.claude/worktrees/feat`, pid: 1 }]);
  expect(await runCli(["list"], s.deps)).toBe(0);
  expect(s.out.join("")).toBe(`@a1 "alice" — on — listed by claude in .claude/worktrees/feat\n`);
  s.out.length = 0;
  expect(await runCli(["alice", "send", "status?"], s.deps)).toBe(0);
  expect(s.sent).toEqual([[{ provider: "claude", sessionId: "full-session", cwd: `${s.root}/.claude/worktrees/feat` }, "status?"]]);
  expect(s.out.join("")).toBe("done\n");
});

test("an on agent whose session is not running is reported as such by list and refused by send, with nothing respawned", async () => {
  const s = await setup({}, async () => { throw new Error("must not send"); }, r => [{ sessionId: "other-session", cwd: r, pid: 1 }]);
  const before = await loadAgents(s.agentsPath);
  expect(await runCli(["list"], s.deps)).toBe(0);
  expect(s.out.join("")).toBe(`@a1 "alice" — on — not listed\n`);
  expect(await runCli(["alice", "send", "hi"], s.deps)).toBe(1);
  expect(s.sent).toEqual([]);
  expect(s.err.join("")).toContain("not-running: agent @a1 is on in bakr's store but its exact session full-session is not a running background session — nothing was sent; the daemon restores it, or run `bakr alice on`");
  expect(s.commands.every(c => c.join(" ") === "claude agents --json")).toBe(true);
  expect(await loadAgents(s.agentsPath)).toEqual(before);
});

test("the exact session running outside the agent's directory is never messaged", async () => {
  const s = await setup({}, async () => { throw new Error("must not send"); }, r => [{ sessionId: "full-session", cwd: `${r}-sibling`, pid: 1 }]);
  expect(await runCli(["list"], s.deps)).toBe(0);
  expect(s.out.join("")).toBe(`@a1 "alice" — on — listed by claude, not sendable (outside-directory)\n`);
  expect(await runCli(["alice", "send", "hi"], s.deps)).toBe(1);
  expect(s.sent).toEqual([]);
  expect(s.err.join("")).toContain("outside-directory:");
});

test("a failed listing refuses send without guessing a cwd", async () => {
  const s = await setup({}, async () => { throw new Error("must not send"); }, () => new Error("daemon down"));
  expect(await runCli(["alice", "send", "hi"], s.deps)).toBe(3);
  expect(s.sent).toEqual([]);
  expect(s.err.join("")).toContain("listing-failed:");
});
