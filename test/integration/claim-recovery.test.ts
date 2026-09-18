// Reboot recovery depends on the claim store: the daemon iterates CLAIMS and
// restores only `on` agents in claimed directories. These tests prove that
// both ways an agent enters a directory — `bakr create` and adopt — persist
// that claim durably before the agent record, and that a fresh daemon (new
// DaemonState, empty claude listing: what a reboot looks like to bakr)
// restores the agent from disk alone. No real claude/herdr here; the fake is
// test/support/fake-host.ts, as in daemon.test.ts.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { adopt } from "../../src/adopt";
import { emptyAgentStore, putAgent } from "../../src/agent-model";
import { load as loadAgents, save as saveAgents } from "../../src/agent-store-io";
import type { ClaimKey } from "../../src/claim-key-resolve";
import { claim, emptyStore, lookup } from "../../src/claim-model";
import { load as loadClaims, save as saveClaims } from "../../src/claim-store-io";
import { runCli, type CliDeps } from "../../src/cli/main";
import { initialDaemonState, runReconcileCycle, type DaemonDeps } from "../../src/daemon";
import { realOrphanProbeDeps, realResolveInputs } from "../../src/paths";
import type { CommandResult, RunCommandOptions } from "../../src/spawn";
import { makeFakeHost } from "../support/fake-host";

const cleanupDirs: string[] = [];
afterEach(async () => { while (cleanupDirs.length) await rm(cleanupDirs.pop()!, { recursive: true, force: true }); });

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  cleanupDirs.push(dir);
  return dir;
}

/**
 * The shared herdr + legacy-claude fake: a launch starts a listed pane with a
 * live pid; a restore resumes its session in a new pane; a stop is a
 * falsifier (recovery never stops anything). `reboot()` ends every session.
 */
function makeFakeClaude() {
  const fake = makeFakeHost();
  async function runCommand(argv: string[], opts: RunCommandOptions): Promise<CommandResult> {
    if ((argv[0] === "herdr" && argv[1] === "workspace" && argv[2] === "close") || (argv[0] === "claude" && argv[1] === "stop")) {
      throw new Error(`FALSIFIER TRIPPED: recovery must never stop a session — got ${JSON.stringify(argv)}`);
    }
    return fake.runCommand(argv, opts);
  }
  /** The session id each restore resumed (`--resume <id>`), in order. */
  const resumedSessions = (): string[] => fake.starts().filter((a) => a.includes("--resume")).map((a) => a[a.indexOf("--resume") + 1]!);
  return { runCommand, panes: fake.panes, resumedSessions, reboot: () => { fake.panes.length = 0; fake.legacy.length = 0; } };
}

function paths(storeDir: string) {
  return { claimsPath: join(storeDir, "claims.json"), agentsPath: join(storeDir, "agents.json") };
}

function daemonDeps(storeDir: string, runCommand: DaemonDeps["runCommand"]): DaemonDeps {
  let counter = 0;
  return {
    runCommand, ...paths(storeDir), sessionSlotsPath: join(storeDir, "session-slots.json"),
    now: () => 1_700_000_000_000, generateAttemptId: () => `daemon-attempt-${counter++}`,
    randomBytes: (n) => new Uint8Array(n).fill(7), probeDeps: realOrphanProbeDeps,
  };
}

let randomCounter = 0; // module-wide, so separate CLI invocations never mint the same agent id

function cliDeps(storeDir: string, cwd: string, runCommand: DaemonDeps["runCommand"]) {
  const out: string[] = [], err: string[] = [];
  let counter = 0;
  const deps: CliDeps = {
    actions: { agentsPath: paths(storeDir).agentsPath, runCommand, now: () => 1_700_000_000_000, generateAttemptId: () => `cli-attempt-${counter++}`, randomBytes: (n) => new Uint8Array(n).fill(++randomCounter & 0xff) },
    adopt: {} as CliDeps["adopt"], claimsPath: paths(storeDir).claimsPath, resolveInputs: realResolveInputs, probeDeps: realOrphanProbeDeps,
    cwd, home: cwd, stdinIsTTY: false, stdoutIsTTY: false,
    stdout: (s) => { out.push(s); }, stderr: (s) => { err.push(s); },
    prompt: async () => { throw new Error("must not prompt"); }, spawnAttach: async () => { throw new Error("must not attach"); },
    messenger: { message: async () => { throw new Error("must not send"); } },
    permissions: { list: async () => { throw new Error("must not read permission prompts"); }, approve: async () => { throw new Error("must not approve a permission prompt"); } },
    permissionAuditPath: "/nonexistent/permission-approvals.jsonl",
  };
  return { deps, out, err };
}

/** One cycle resolves create's launch into a restoreTarget; then a simulated reboot and ONE cycle from a fresh DaemonState. */
async function rebootAndReconcile(storeDir: string, fake: ReturnType<typeof makeFakeClaude>) {
  const deps = daemonDeps(storeDir, fake.runCommand);
  await runReconcileCycle(initialDaemonState(), deps);
  fake.reboot();
  return runReconcileCycle(initialDaemonState(), deps);
}

describe("bakr create claims its directory", () => {
  test("the claim is persisted (with directory identity) and reloads in a separate process", async () => {
    const storeDir = await makeTempDir("bakr-claim-recovery-store-");
    const workspace = await makeTempDir("bakr-claim-recovery-ws-");
    const fake = makeFakeClaude();
    const cli = cliDeps(storeDir, workspace, fake.runCommand);

    expect(await runCli(["create", "--name", "worker"], cli.deps)).toBe(0);
    expect(cli.err).toEqual([]);

    const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "fixtures", "load-and-assert.ts"), paths(storeDir).claimsPath, workspace], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect(stderr).toBe("");
    expect(await proc.exited).toBe(0);
    const reloaded = JSON.parse(stdout);
    expect(reloaded.key).toBe(workspace);
    expect(reloaded.dirIdentity).toEqual({ dev: expect.any(Number), ino: expect.any(Number) });
  }, 20000);

  test("a second create in the same directory keeps the original claim unchanged", async () => {
    const storeDir = await makeTempDir("bakr-claim-recovery-store-");
    const workspace = await makeTempDir("bakr-claim-recovery-ws-");
    const key = workspace as ClaimKey;
    await saveClaims(paths(storeDir).claimsPath, claim(emptyStore(), key, 42).state);
    const fake = makeFakeClaude();

    expect(await runCli(["create", "--name", "one"], cliDeps(storeDir, workspace, fake.runCommand).deps)).toBe(0);
    expect(await runCli(["create", "--name", "two"], cliDeps(storeDir, workspace, fake.runCommand).deps)).toBe(0);

    const claims = await loadClaims(paths(storeDir).claimsPath);
    expect(claims.status).toBe("loaded");
    if (claims.status === "loaded") {
      expect(Object.keys(claims.state.claims)).toEqual([key]);
      expect(lookup(claims.state, key)?.claimedAt).toBe(42);
    }
  });

  test("a malformed claim store refuses create before any agent is written, and leaves the file untouched", async () => {
    const storeDir = await makeTempDir("bakr-claim-recovery-store-");
    const workspace = await makeTempDir("bakr-claim-recovery-ws-");
    await writeFile(paths(storeDir).claimsPath, "{ not json", "utf8");
    const fake = makeFakeClaude();
    const cli = cliDeps(storeDir, workspace, fake.runCommand);

    expect(await runCli(["create"], cli.deps)).toBe(3);
    expect(cli.err.join("")).toContain("store-malformed");
    expect(await readFile(paths(storeDir).claimsPath, "utf8")).toBe("{ not json");
    expect((await loadAgents(paths(storeDir).agentsPath)).status).toBe("missing");
  });
});

describe("restart recovery follows the claim", () => {
  test("an agent made by `bakr create` is respawned by a fresh daemon after a reboot", async () => {
    const storeDir = await makeTempDir("bakr-claim-recovery-store-");
    const workspace = await makeTempDir("bakr-claim-recovery-ws-");
    const fake = makeFakeClaude();
    expect(await runCli(["create"], cliDeps(storeDir, workspace, fake.runCommand).deps)).toBe(0);
    const created = fake.panes.map((p) => p.sessionId);
    expect(created).toHaveLength(1);

    const result = await rebootAndReconcile(storeDir, fake);
    expect(result.claimDegraded).toBe(false);
    expect(result.restored).toHaveLength(1);
    expect(result.restored[0]?.key).toBe(workspace as ClaimKey);
    // The session `create` started is the one resumed, in the claimed directory.
    expect(fake.resumedSessions()).toEqual(created);
    expect(fake.panes.map((p) => p.cwd)).toEqual([workspace]);
  });

  test("NEGATIVE CONTROL: the same on agent in an UNCLAIMED directory is not restored — the claim is what recovery depends on", async () => {
    const storeDir = await makeTempDir("bakr-claim-recovery-store-");
    const workspace = await makeTempDir("bakr-claim-recovery-ws-");
    const fake = makeFakeClaude();
    expect(await runCli(["create"], cliDeps(storeDir, workspace, fake.runCommand).deps)).toBe(0);
    await saveClaims(paths(storeDir).claimsPath, emptyStore());

    const result = await rebootAndReconcile(storeDir, fake);
    expect(result.restored).toEqual([]);
    expect(fake.resumedSessions()).toEqual([]);
  });

  test("an adopted agent is respawned in its destination by a fresh daemon after a reboot", async () => {
    const storeDir = await makeTempDir("bakr-claim-recovery-store-");
    const parent = await makeTempDir("bakr-claim-recovery-src-");
    const source = join(parent, "moved-away") as ClaimKey;
    await mkdir(source);
    const destination = await makeTempDir("bakr-claim-recovery-dest-");
    await saveClaims(paths(storeDir).claimsPath, claim(emptyStore(), source, 1).state);
    await saveAgents(paths(storeDir).agentsPath, putAgent(emptyAgentStore(), {
      id: "@a1", name: undefined, directory: source, state: "on", createdAt: 1,
      birthSessionId: "durable-x", restoreTarget: { sessionId: "durable-x", shortId: "durable-x" },
    }));
    await rm(source, { recursive: true });

    const outcome = await adopt(
      { ...paths(storeDir), now: () => 1_700_000_000_000, resolveInputs: realResolveInputs, lexicalInputs: { cwd: process.cwd(), home: homedir() }, probeDeps: realOrphanProbeDeps },
      { source, destinationInput: destination, agentIds: ["@a1"] },
    );
    expect(outcome.ok).toBe(true);

    const claims = await loadClaims(paths(storeDir).claimsPath);
    expect(claims.status === "loaded" && lookup(claims.state, destination as ClaimKey)?.dirIdentity).toEqual({ dev: expect.any(Number), ino: expect.any(Number) });

    const fake = makeFakeClaude();
    fake.reboot();
    const result = await runReconcileCycle(initialDaemonState(), daemonDeps(storeDir, fake.runCommand));
    expect(result.restored).toEqual([{ agentId: "@a1", key: destination as ClaimKey, sessionId: "durable-x" }]);
    expect(fake.resumedSessions()).toEqual(["durable-x"]);
    expect(fake.panes.map((p) => p.cwd)).toEqual([destination]); // resumed in its DESTINATION, not the vanished source
  });
});
