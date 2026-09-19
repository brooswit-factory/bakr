// BAKR-34/BAKR-42's own acceptance criterion, verbatim: "A CLI test: from an
// unrelated cwd, `bakr brooswit-factory/butchr off` then `on` acts on the
// right agent; `bakr @id ...` works from any cwd; `bakr <old-custom-name>`
// prints the rename hint and changes nothing." This file is that test, and
// (per BAKR-42's own falsifier requirement) doubles as the falsifier target:
// with R4's global resolution reverted — a directory-scoped
// `resolveAgent`, the pre-BAKR-42 shape — every case here must fail with
// `not-found` (an id/name no longer matches from outside its own directory)
// rather than passing. See BAKR-45's ticket comment for the falsifier's own
// captured output; this file is not itself the mechanism that reverts
// anything (see the module comment on `test/integration/claim-recovery.test.ts`
// for the pattern this borrows: a real CLI dispatch, a real fake herdr host,
// no directory-scope assumption baked into the harness).

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveDirectoryNames } from "../../src/agent-name";
import { load as loadAgents, save as saveAgents } from "../../src/agent-store-io";
import { runCli, type CliDeps } from "../../src/cli/main";
import { realOrphanProbeDeps, realResolveInputs } from "../../src/paths";
import type { CommandResult, RunCommandOptions } from "../../src/spawn";
import { makeFakeHost } from "../support/fake-host";

const dirs: string[] = [];
afterEach(async () => { while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true }); });

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

function paths(storeDir: string) {
  return { claimsPath: join(storeDir, "claims.json"), agentsPath: join(storeDir, "agents.json") };
}

let randomCounter = 0; // module-wide, so separate CLI invocations never mint the same agent id

function cliDeps(storeDir: string, cwd: string, runCommand: (argv: string[], opts: RunCommandOptions) => Promise<CommandResult>) {
  const out: string[] = [], err: string[] = [];
  let counter = 0;
  const deps: CliDeps = {
    actions: { agentsPath: paths(storeDir).agentsPath, runCommand, now: () => 1_700_000_000_000, generateAttemptId: () => `cli-attempt-${counter++}`, randomBytes: (n) => new Uint8Array(n).fill(++randomCounter & 0xff) },
    adopt: {} as CliDeps["adopt"], claimsPath: paths(storeDir).claimsPath, resolveInputs: realResolveInputs, probeDeps: realOrphanProbeDeps,
    cwd, home: cwd, stdinIsTTY: false, stdoutIsTTY: false,
    stdout: (s) => { out.push(s); }, stderr: (s) => { err.push(s); },
    prompt: async () => { throw new Error("must not prompt"); }, spawnAttach: async () => { throw new Error("must not attach"); },
    messenger: { message: async () => { throw new Error("must not send"); } },
    permissions: { list: async () => { throw new Error("must not read permission prompts"); } },
  };
  return { deps, out, err };
}

test("from an unrelated cwd: `<name> off` then `on` acts on the right agent, `@id ...` works from any cwd, and `<old-custom-name>` prints the rename hint and changes nothing", async () => {
  const storeDir = await makeTempDir("bakr-any-cwd-store-");
  const agentDir = await makeTempDir("bakr-any-cwd-agent-");
  const unrelatedCwd = await makeTempDir("bakr-any-cwd-unrelated-");
  const host = makeFakeHost();

  // Create the agent from ITS OWN directory — the one and only step in this
  // test that runs with a matching cwd.
  const created = cliDeps(storeDir, agentDir, host.runCommand);
  expect(await runCli(["create"], created.deps)).toBe(0);
  expect(created.err).toEqual([]);

  const name = deriveDirectoryNames([agentDir]).get(agentDir)!;
  const loadedAfterCreate = await loadAgents(paths(storeDir).agentsPath);
  expect(loadedAfterCreate.status).toBe("loaded");
  const agentId = loadedAfterCreate.status === "loaded" ? Object.keys(loadedAfterCreate.state.agents)[0]! : (() => { throw new Error("store did not load"); })();

  // --- `<name> off` then `on`, both dispatched from the UNRELATED cwd ------
  const off1 = cliDeps(storeDir, unrelatedCwd, host.runCommand);
  expect(await runCli([name, "off"], off1.deps)).toBe(0);
  expect(off1.err).toEqual([]);
  {
    const loaded = await loadAgents(paths(storeDir).agentsPath);
    expect(loaded.status === "loaded" && loaded.state.agents[agentId]?.state).toBe("off");
  }

  const on1 = cliDeps(storeDir, unrelatedCwd, host.runCommand);
  expect(await runCli([name, "on"], on1.deps)).toBe(0);
  expect(on1.err).toEqual([]);
  {
    const loaded = await loadAgents(paths(storeDir).agentsPath);
    expect(loaded.status === "loaded" && loaded.state.agents[agentId]?.state).toBe("on");
  }

  // --- `@id ...` also works from the unrelated cwd --------------------------
  const off2 = cliDeps(storeDir, unrelatedCwd, host.runCommand);
  expect(await runCli([agentId, "off"], off2.deps)).toBe(0);
  expect(off2.err).toEqual([]);
  {
    const loaded = await loadAgents(paths(storeDir).agentsPath);
    expect(loaded.status === "loaded" && loaded.state.agents[agentId]?.state).toBe("off");
  }

  // --- R8: a stale legacy custom name refuses with the rename hint, and
  // changes NOTHING — simulating an agent record written before this change
  // (`AgentRecord.name` populated), the shape R8's one-release hint exists
  // for. Mutating the store directly (not through the retired `name`/
  // `rename` verbs, which no longer exist — R9).
  const beforeHint = await loadAgents(paths(storeDir).agentsPath);
  if (beforeHint.status !== "loaded") throw new Error("store did not load");
  const agentBeforeHint = beforeHint.state.agents[agentId]!;
  await saveAgents(paths(storeDir).agentsPath, {
    ...beforeHint.state,
    agents: { ...beforeHint.state.agents, [agentId]: { ...agentBeforeHint, name: "old-custom-name" } },
  });

  const hint = cliDeps(storeDir, unrelatedCwd, host.runCommand);
  expect(await runCli(["old-custom-name"], hint.deps)).toBe(1);
  expect(hint.out).toEqual([]);
  expect(hint.err.join("")).toBe(`renamed: "old-custom-name" was a custom name; an agent's name is now derived from its directory — use "${name}" instead (or its @id, ${agentId})\n`);

  const afterHint = await loadAgents(paths(storeDir).agentsPath);
  expect(afterHint.status === "loaded" && afterHint.state.agents[agentId]).toEqual({ ...agentBeforeHint, name: "old-custom-name" });
});
