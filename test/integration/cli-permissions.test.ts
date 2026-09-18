import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyAgentStore, putAgent, type AgentRecord } from "../../src/agent-model";
import { save as saveAgents } from "../../src/agent-store-io";
import type { ClaimKey } from "../../src/claim-key-resolve";
import { runCli, type CliDeps } from "../../src/cli/main";
import { herdrPermissions } from "../../src/cli/herdr-transport";
import { realOrphanProbeDeps, realResolveInputs } from "../../src/paths";
import { makeFakeHost, permissionScreen, type FakeHost } from "../support/fake-host";

const dirs: string[] = [];
afterEach(async () => { while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true }); });

/** Listing prompts reads herdr's agent list and each pane's screen — it never types into a pane. */
const isReadOnly = (argv: string[]): boolean => argv.join(" ") === "herdr agent list" || (argv[0] === "herdr" && argv[1] === "agent" && argv[2] === "read");

type AgentSpec = { id: string; name: string; sessionId: string; screen?: string; restoreTarget?: "own-pane" | "none" | { shortId: string } };

/** Two or more agents in one directory, each on its own fake herdr pane; the `permissions` host reads those panes through the real herdr adapter and drovr. */
async function setup(specs: AgentSpec[], opts: { failListing?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bakr-cli-permissions-")));
  dirs.push(root);
  const agentsPath = join(root, "agents.json");
  const host: FakeHost = makeFakeHost({ failListing: opts.failListing ?? false });
  const panes = new Map(specs.map((s) => [s.id, host.addPane({ cwd: root, sessionId: s.sessionId, ...(s.screen === undefined ? {} : { screen: s.screen }) })]));
  let store = emptyAgentStore();
  for (const s of specs) {
    const target = s.restoreTarget ?? "own-pane";
    const restoreTarget = target === "none" ? undefined : { sessionId: s.sessionId, shortId: target === "own-pane" ? panes.get(s.id)!.paneId : target.shortId };
    const agent: AgentRecord = { id: s.id, name: s.name, directory: root as ClaimKey, state: "on", createdAt: 1, birthSessionId: restoreTarget?.sessionId, restoreTarget } as AgentRecord;
    store = putAgent(store, agent);
  }
  await saveAgents(agentsPath, store);
  const out: string[] = [], err: string[] = [], commands: string[][] = [];
  const runCommand: typeof host.runCommand = async (argv, o) => {
    commands.push(argv);
    if (!isReadOnly(argv)) throw new Error(`permissions must not run ${argv.join(" ")}`);
    return host.runCommand(argv, o);
  };
  const deps: CliDeps = {
    actions: { agentsPath, runCommand: async (argv) => { throw new Error(`permissions must not run an agent action: ${argv.join(" ")}`); }, now: () => 1, generateAttemptId: () => "x", randomBytes: (n) => new Uint8Array(n) },
    adopt: {} as CliDeps["adopt"], claimsPath: join(root, "claims.json"), resolveInputs: realResolveInputs, probeDeps: realOrphanProbeDeps,
    cwd: root, home: root, stdinIsTTY: false, stdoutIsTTY: false,
    stdout: (s) => { out.push(s); }, stderr: (s) => { err.push(s); },
    prompt: async () => { throw new Error("must not prompt"); }, spawnAttach: async () => { throw new Error("must not attach"); },
    messenger: { message: async () => { throw new Error("must not send"); } },
    permissions: herdrPermissions(runCommand),
  };
  return { root, deps, out, err, commands, host, panes };
}

const alicePrompt = permissionScreen("Bash command", ["touch notes.txt", "Create an empty notes file"]);
const bobPrompt = permissionScreen("Write", ["/srv/bob/secrets.env"], ["Yes", "No"]);

test("an agent with one pending prompt gets its tool, request, options and promptId", async () => {
  const s = await setup([{ id: "@a1", name: "alice", sessionId: "alice-session", screen: alicePrompt }]);
  expect(await runCli(["alice", "permissions"], s.deps)).toBe(0);
  const pane = s.panes.get("@a1")!.paneId;
  const promptId = s.out.join("").match(/^promptId: ([0-9a-f]+)$/m)?.[1];
  expect(promptId).toMatch(/^[0-9a-f]{16}$/);
  expect(s.out.join("")).toBe([
    `pane: ${pane}`,
    "tool: Bash command",
    "request:",
    "  touch notes.txt",
    "  Create an empty notes file",
    "question: Do you want to proceed?",
    "options:",
    "  > 1. Yes",
    "    2. Yes, and always allow access to this directory from this project",
    "    3. No",
    `promptId: ${promptId}`,
    "",
  ].join("\n"));
  expect(s.err).toEqual([]);
  expect(s.commands.every(isReadOnly)).toBe(true);
});

test("an agent with none prints `no pending prompts` and exits 0", async () => {
  const s = await setup([{ id: "@a1", name: "alice", sessionId: "alice-session" }]);
  expect(await runCli(["@a1", "permissions"], s.deps)).toBe(0);
  expect(s.out.join("")).toBe("no pending prompts\n");
  expect(s.err).toEqual([]);
});

// The filter this command exists for: drovr lists every Claude pane on the
// host, and another agent's prompt must never reach this agent's output.
test("a pending prompt on a DIFFERENT agent's pane is not listed", async () => {
  const s = await setup([
    { id: "@a1", name: "alice", sessionId: "alice-session" },
    { id: "@a2", name: "bob", sessionId: "bob-session", screen: bobPrompt },
  ]);
  // bob's prompt really is pending, and visible to anyone reading every pane.
  expect((await s.deps.permissions.list()).map((p) => p.paneId)).toEqual([s.panes.get("@a2")!.paneId]);
  expect(await runCli(["alice", "permissions"], s.deps)).toBe(0);
  expect(s.out.join("")).toBe("no pending prompts\n");
  expect(s.out.join("")).not.toContain("secrets.env");
  expect(s.out.join("")).not.toContain(s.panes.get("@a2")!.paneId);
});

test("with prompts on both panes, each agent sees only its own", async () => {
  const s = await setup([
    { id: "@a1", name: "alice", sessionId: "alice-session", screen: alicePrompt },
    { id: "@a2", name: "bob", sessionId: "bob-session", screen: bobPrompt },
  ]);
  expect(await runCli(["alice", "permissions"], s.deps)).toBe(0);
  expect(s.out.join("")).toContain("touch notes.txt");
  expect(s.out.join("")).not.toContain("secrets.env");
  expect(s.out.join("").match(/^promptId: /gm)).toHaveLength(1);
  s.out.length = 0;
  expect(await runCli(["bob", "permissions"], s.deps)).toBe(0);
  expect(s.out.join("")).toContain("/srv/bob/secrets.env");
  expect(s.out.join("")).not.toContain("touch notes.txt");
});

test("a pane carrying this agent's pane id but another session is not this agent's", async () => {
  // alice's restore target is stale and names the pane id bob now occupies.
  const s = await setup([
    { id: "@a2", name: "bob", sessionId: "bob-session", screen: bobPrompt },
    { id: "@a1", name: "alice", sessionId: "alice-session", restoreTarget: { shortId: "w1:p1" } },
  ]);
  expect(s.panes.get("@a2")!.paneId).toBe("w1:p1");
  expect(await runCli(["alice", "permissions"], s.deps)).toBe(0);
  expect(s.out.join("")).toBe("no pending prompts\n");
});

test("an unknown agent is refused like every other verb refuses it, before any pane is read", async () => {
  const s = await setup([{ id: "@a1", name: "alice", sessionId: "alice-session", screen: alicePrompt }]);
  expect(await runCli(["carol", "permissions"], s.deps)).toBe(1);
  expect(s.err.join("")).toBe(`not-found: no agent "carol" found in this directory\n`);
  expect(s.out).toEqual([]);
  expect(s.commands).toEqual([]);
  // Same code `send` gives the same unknown ref.
  s.err.length = 0;
  expect(await runCli(["carol", "send", "hi"], s.deps)).toBe(1);
  expect(s.err.join("")).toBe(`not-found: no agent "carol" found in this directory\n`);
});

test("an agent that was never launched says so plainly instead of reading any pane", async () => {
  const s = await setup([
    { id: "@a1", name: "alice", sessionId: "alice-session", restoreTarget: "none" },
    { id: "@a2", name: "bob", sessionId: "bob-session", screen: bobPrompt },
  ]);
  expect(await runCli(["alice", "permissions"], s.deps)).toBe(0);
  expect(s.out.join("")).toBe(`@a1 "alice" has never been launched, so it has no pane to prompt on: no pending prompts\n`);
  expect(s.commands).toEqual([]);
});

test("a failed pane listing is a failure, not an empty answer", async () => {
  const s = await setup([{ id: "@a1", name: "alice", sessionId: "alice-session", screen: alicePrompt }], { failListing: true });
  expect(await runCli(["alice", "permissions"], s.deps)).toBe(3);
  expect(s.out).toEqual([]);
  expect(s.err.join("")).toContain("listing-failed: cannot read agent @a1's pane: simulated listing failure");
});

test("an agent still on legacy `claude --bg` is told its prompts cannot be read there", async () => {
  const s = await setup([{ id: "@a1", name: "alice", sessionId: "alice-session", restoreTarget: { shortId: "fullsess" } }]);
  expect(await runCli(["alice", "permissions"], s.deps)).toBe(0);
  expect(s.out.join("")).toBe("no pending prompts\n");
  expect(s.err.join("")).toContain("note: agent @a1 still runs under legacy `claude --bg` (fullsess)");
});
