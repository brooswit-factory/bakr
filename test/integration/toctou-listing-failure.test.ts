// BAKR-23's caught incident: the TOCTOU re-check inside
// `dispatchRespawnForDaemon` (daemon.ts) originally treated a THROWN
// listing the same as "not alive" and proceeded to respawn anyway — an
// unannounced stop hidden inside "restore" (B7) caused by a transient CLI
// hiccup rather than any fact about the session. Fixed by routing the
// re-check through the real `checkLiveness`, whose verdict now
// distinguishes `absent` (listing succeeded, genuinely not found — the
// only verdict that proceeds) from `listing-failed` (the listing call
// itself threw — refuses, same as `alive`/`not-verifiable`).
//
// Falsifier: if `listing-failed` were still folded into "not alive"/
// "absent", `respawnSession` would be called and the fake host would record
// a `herdr agent start ... -- --resume <session>`.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyAgentStore, putAgent, type AgentRecord } from "../../src/agent-model";
import { save as saveAgents, load as loadAgents } from "../../src/agent-store-io";
import { claim, emptyStore } from "../../src/claim-model";
import { save as saveClaims } from "../../src/claim-store-io";
import { initialDaemonState, runReconcileCycle, type DaemonDeps } from "../../src/daemon";
import type { ClaimKey } from "../../src/claim-key-resolve";
import type { OrphanProbeDeps } from "../../src/orphan-probe";
import type { RunCommand } from "../../src/spawn";
import { makeFakeHost } from "../support/fake-host";

const alwaysPresentProbeDeps: OrphanProbeDeps = { stat: async () => ({ dev: 1, ino: 1, isDirectory: () => true }) };
const KEY = "/claimed/dir" as ClaimKey;
const AGENT_ID = "@toctou-agent";
const SHORT_ID = "toctoush";
const SESSION_ID = "toctou-session-uuid";

const cleanupDirs: string[] = [];
afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});
async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bakr-toctou-test-"));
  cleanupDirs.push(dir);
  return dir;
}

function agentWithRestoreTarget(): AgentRecord {
  return { id: AGENT_ID, name: undefined, directory: KEY, state: "on", createdAt: 1, birthSessionId: "birth", restoreTarget: { sessionId: SESSION_ID, shortId: SHORT_ID } };
}

const isList = (argv: readonly string[]): boolean => argv[0] === "herdr" && argv[1] === "agent" && argv[2] === "list";

function daemonDeps(dir: string, runCommand: RunCommand): DaemonDeps {
  let counter = 0;
  return {
    runCommand,
    claimsPath: join(dir, "claims.json"),
    agentsPath: join(dir, "agents.json"),
    sessionSlotsPath: join(dir, "session-slots.json"),
    now: () => 1_700_000_000_000,
    generateAttemptId: () => `attempt-${counter++}`,
    randomBytes: (n: number) => new Uint8Array(n).fill(1),
    probeDeps: alwaysPresentProbeDeps,
    launchConfigDeps: { readConfigFile: async () => undefined },
  };
}

async function seed(): Promise<string> {
  const dir = await makeTempDir();
  await saveClaims(join(dir, "claims.json"), claim(emptyStore(), KEY, 1).state);
  await saveAgents(join(dir, "agents.json"), putAgent(emptyAgentStore(), agentWithRestoreTarget()));
  return dir;
}

async function respawnRecordError(dir: string): Promise<string | undefined> {
  const loaded = await loadAgents(join(dir, "agents.json"));
  if (loaded.status !== "loaded") throw new Error("expected loaded store");
  return loaded.state.launches.find((l) => l.attemptKey?.kind === "respawn")?.error;
}

describe("the TOCTOU re-check before respawn (BAKR-23's caught incident)", () => {
  test("a listing failure on the RE-CHECK (the second listing — `herdr agent list` throws) refuses — respawnSession is NEVER called", async () => {
    const dir = await seed();
    // The decision-phase listing (inside decideAndBeginForAgent) succeeds with
    // the session genuinely absent -> begin-respawn is chosen. The TOCTOU
    // RE-CHECK, immediately before the actual spawn, throws.
    const fake = makeFakeHost({ failListing: () => fake.calls.filter(isList).length >= 2 });

    await runReconcileCycle(initialDaemonState(), daemonDeps(dir, fake.runCommand));

    expect(fake.calls.filter(isList)).toHaveLength(2); // the re-check really ran
    expect(fake.starts()).toEqual([]); // FALSIFIER: a restore here would be a start carrying --resume
    expect(await respawnRecordError(dir)).toContain("listing-failed");
  });

  test("a listing failure on the RE-CHECK where the LEGACY half (`claude agents --json`) exits non-zero also refuses", async () => {
    const dir = await seed();
    const fake = makeFakeHost();
    let legacyListings = 0;
    const runCommand: RunCommand = async (argv, opts) => {
      if (argv[0] === "claude" && argv[1] === "agents" && ++legacyListings >= 2) return { exitCode: 1, stdout: "", stderr: "claude: temporary failure, try again" };
      return fake.runCommand(argv, opts);
    };

    await runReconcileCycle(initialDaemonState(), daemonDeps(dir, runCommand));

    expect(legacyListings).toBe(2);
    expect(fake.starts()).toEqual([]);
    expect(await respawnRecordError(dir)).toContain("listing-failed");
  });

  test("an operator who resumed the session in a pane between the decision and the re-check is found ALIVE by its session id (in a pane whose id is not the recorded short id) — never restored over", async () => {
    const dir = await seed();
    const fake = makeFakeHost();
    const runCommand: RunCommand = async (argv, opts) => {
      if (isList(argv) && fake.calls.filter(isList).length === 1) fake.addPane({ cwd: KEY, sessionId: SESSION_ID });
      return fake.runCommand(argv, opts);
    };

    await runReconcileCycle(initialDaemonState(), daemonDeps(dir, runCommand));

    expect(fake.starts()).toEqual([]);
    expect(fake.panes).toHaveLength(1); // only the operator's pane
    expect(await respawnRecordError(dir)).toContain('"alive"');
  });

  test("POSITIVE CONTROL: when the re-check listing genuinely succeeds and reports absent, respawnSession IS called — the refusals above are not because respawn is unreachable in general", async () => {
    const dir = await seed();
    const fake = makeFakeHost();

    await runReconcileCycle(initialDaemonState(), daemonDeps(dir, fake.runCommand));

    expect(fake.calls.filter(isList)).toHaveLength(2);
    expect(fake.starts()).toEqual([["--resume", SESSION_ID]]);
  });
});
