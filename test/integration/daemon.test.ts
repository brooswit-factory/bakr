import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claim, emptyStore } from "../../src/claim-model";
import { realOrphanProbeDeps } from "../../src/paths";
import { save as saveClaims } from "../../src/claim-store-io";
import { emptySessionSlots, beginLaunch, markLaunchStarted, resolveLaunch, markLaunchFailed, serializeSessionSlotsState } from "../../src/session-slots";
import { save as saveAgents, load as loadAgents } from "../../src/agent-store-io";
import { emptyAgentStore, putAgent, unresolvedLaunches, type AgentRecord } from "../../src/agent-model";
import { initialDaemonState, runReconcileCycle, type DaemonDeps } from "../../src/daemon";
import type { ClaimKey } from "../../src/claim-key-resolve";
import type { RunCommandOptions, CommandResult } from "../../src/spawn";
import { makeFakeHost, type FakeHostOptions } from "../support/fake-host";
import type { OrphanProbeDeps } from "../../src/orphan-probe";
import type { McpSettingsIo } from "@brooswit/drovr";

/** In-memory vendor settings that also record when each write happened, relative to the commands run. */
function memorySettings(events: string[]): McpSettingsIo & { files: Record<string, string> } {
  const files: Record<string, string> = {};
  return {
    files,
    readSettings: async (path) => files[path],
    writeSettings: async (path, contents) => { files[path] = contents; events.push(`write ${path}`); },
  };
}

/** These tests use symbolic paths like "/claimed/dir" that do not exist on the real filesystem — a real `stat` would classify every one of them as orphaned. This fake always reports "exists", preserving the pre-BAKR-24 behaviour (every claimed directory is `present`) for every test that isn't specifically exercising Q4's orphan-reporting behaviour (see the dedicated "BAKR-24" describe block below, which builds its own real-directory fixtures instead). */
export const alwaysPresentProbeDeps: OrphanProbeDeps = { stat: async () => ({ dev: 1, ino: 1, isDirectory: () => true }) };

const cleanupDirs: string[] = [];

afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bakr-daemon-test-"));
  cleanupDirs.push(dir);
  return dir;
}

function baseDeps(dir: string, runCommand: DaemonDeps["runCommand"]): DaemonDeps {
  let counter = 0;
  let randomCounter = 0;
  return {
    runCommand,
    claimsPath: join(dir, "claims.json"),
    agentsPath: join(dir, "agents.json"),
    sessionSlotsPath: join(dir, "session-slots.json"),
    now: () => 1_700_000_000_000,
    generateAttemptId: () => `attempt-${counter++}`,
    randomBytes: (n: number) => {
      randomCounter += 1;
      return new Uint8Array(n).fill(randomCounter & 0xff);
    },
    probeDeps: alwaysPresentProbeDeps,
    // Pinned rather than inherited: the default reads this HOST's own
    // `BAKR_MCP_NOTIFICATION_SERVERS` and `.mcp.json`/`.bakr.json` files, which would make
    // what a reconcile launches depend on the machine running the test.
    launchConfigDeps: { readConfigFile: async () => undefined },
  };
}

function makeAgent(overrides: Partial<AgentRecord> & { id: string; directory: ClaimKey }): AgentRecord {
  return { name: undefined, state: "on", createdAt: 1, birthSessionId: undefined, restoreTarget: undefined, ...overrides };
}

/** Whether an argv stops a session: a herdr workspace close or a legacy `claude stop`. */
const isStop = (argv: readonly string[]): boolean =>
  (argv[0] === "herdr" && argv[1] === "workspace" && argv[2] === "close") || (argv[0] === "claude" && argv[1] === "stop");

/**
 * The shared stateful fake of herdr + legacy claude (test/support/fake-host.ts):
 * a fresh launch starts a pane that names its own session (`--session-id`), a
 * restore (`--resume <sessionId>`) starts a NEW pane holding the SAME session
 * id, and every listed pane carries this test process's own pid, so it
 * verifies alive. THROWS on any stop — a workspace close or a legacy
 * `claude stop` — arming the AC3 falsifier ("fail loudly if the loop ever
 * issues a stop") across every test that uses it.
 */
function makeNoStopHost(opts?: FakeHostOptions) {
  const fake = makeFakeHost(opts);
  const runCommand = async (argv: string[], o: RunCommandOptions): Promise<CommandResult> => {
    if (isStop(argv)) throw new Error(`FALSIFIER TRIPPED: this loop must never issue a stop (B7) — got: ${JSON.stringify(argv)}`);
    return fake.runCommand(argv, o);
  };
  /** The claude argv of every restore (a start carrying `--resume`). */
  const restores = (): string[][] => fake.starts().filter((args) => args.includes("--resume"));
  return { ...fake, runCommand, restores };
}

/** The directories every `herdr workspace create` was rooted at, in order. */
const createdCwds = (calls: readonly string[][]): string[] =>
  calls.filter((c) => c[0] === "herdr" && c[1] === "workspace" && c[2] === "create").map((c) => c[c.indexOf("--cwd") + 1]!);

const nextState = (result: Awaited<ReturnType<typeof runReconcileCycle>>) =>
  ({ claimDegraded: result.claimDegraded, agentsDegraded: result.agentsDegraded, orphanReportSignatures: result.orphanReportSignatures });

describe("Constraint 3: a malformed claim store degrades the daemon", () => {
  test("no restore, no write, and the process never re-tries reading it as anything but degraded", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "claims.json"), "{ not json", "utf8");
    let calls = 0;
    const deps = baseDeps(dir, async () => {
      calls += 1;
      return { exitCode: 0, stdout: "[]", stderr: "" };
    });

    const result1 = await runReconcileCycle(initialDaemonState(), deps);
    expect(result1.claimDegraded).toBe(true);
    expect(result1.restored).toEqual([]);
    expect(calls).toBe(0);

    const result2 = await runReconcileCycle({ claimDegraded: result1.claimDegraded, agentsDegraded: result1.agentsDegraded, orphanReportSignatures: result1.orphanReportSignatures }, deps);
    expect(result2.claimDegraded).toBe(true);
    expect(calls).toBe(0);
  });
});

describe("AC6/AC13: a malformed agents.json degrades the daemon and is NEVER treated as absent", () => {
  test("no restore, no write to agents.json, and session-slots.json is NEVER read as a fallback (R-A.1)", async () => {
    const dir = await makeTempDir();
    const key = "/claimed/dir" as ClaimKey;
    await saveClaims(join(dir, "claims.json"), claim(emptyStore(), key, 1).state);
    await writeFile(join(dir, "agents.json"), "{ not json at all", "utf8");
    // A perfectly valid session-slots.json sits right beside it — falsifier: any agent restored from it, or any write derived from it.
    let slots = emptySessionSlots();
    slots = beginLaunch(slots, key, undefined, "seed", 1);
    slots = markLaunchStarted(slots, "seed", "seed-short");
    slots = resolveLaunch(slots, "seed-short", "durable-should-never-be-touched");
    await writeFile(join(dir, "session-slots.json"), serializeSessionSlotsState(slots), "utf8");

    let calls = 0;
    const deps = baseDeps(dir, async () => {
      calls += 1;
      return { exitCode: 0, stdout: "[]", stderr: "" };
    });

    const result = await runReconcileCycle(initialDaemonState(), deps);
    expect(result.agentsDegraded).toBe(true);
    expect(result.restored).toEqual([]);
    expect(calls).toBe(0); // never even lists — degraded before the listing step

    // agents.json is byte-for-byte unchanged — never migrated into, never overwritten.
    const raw = await Bun.file(join(dir, "agents.json")).text();
    expect(raw).toBe("{ not json at all");
  });

  test("NEGATIVE CONTROL: the identical setup, but agents.json is genuinely ABSENT, DOES migrate — proving the check above is 'correctly refused', not 'never reads that file at all'", async () => {
    const dir = await makeTempDir();
    const key = "/claimed/dir" as ClaimKey;
    await saveClaims(join(dir, "claims.json"), claim(emptyStore(), key, 1).state);
    let slots = emptySessionSlots();
    slots = beginLaunch(slots, key, undefined, "seed", 1);
    slots = markLaunchStarted(slots, "seed", "seed-short");
    slots = resolveLaunch(slots, "seed-short", "durable-1");
    await writeFile(join(dir, "session-slots.json"), serializeSessionSlotsState(slots), "utf8");
    // agents.json does NOT exist.

    const fake = makeNoStopHost();
    const deps = baseDeps(dir, fake.runCommand);
    const result = await runReconcileCycle(initialDaemonState(), deps);
    expect(result.agentsDegraded).toBe(false);
    expect(result.restored).toHaveLength(1); // the migrated agent WAS restored
    const loaded = await loadAgents(join(dir, "agents.json"));
    expect(loaded.status).toBe("loaded");
    if (loaded.status === "loaded") expect(Object.keys(loaded.state.agents)).toHaveLength(1);
  });
});

describe("missing stores: a normal, empty first run", () => {
  test("no files on disk yet -> not degraded, nothing restored, listing still happens", async () => {
    const dir = await makeTempDir();
    const fake = makeNoStopHost();
    const deps = baseDeps(dir, fake.runCommand);

    const result = await runReconcileCycle(initialDaemonState(), deps);
    expect(result.claimDegraded).toBe(false);
    expect(result.agentsDegraded).toBe(false);
    expect(result.skippedListingFailed).toBe(false); // the listing genuinely SUCCEEDED — not a vacuous "nothing restored" from a failed one
    expect(result.restored).toEqual([]);
    // Exactly ONE listing: herdr's panes plus the legacy background sessions, nothing else.
    expect(fake.calls.map((c) => c.slice(0, 3))).toEqual([["herdr", "agent", "list"], ["claude", "agents", "--json"]]);
  });
});

describe("Constraint 1: a listing failure makes the whole cycle a no-op", () => {
  // Either half of the listing failing is a listing failure: herdr's panes, or the legacy `claude agents --json`.
  const failures: readonly [string, (fake: ReturnType<typeof makeNoStopHost>) => DaemonDeps["runCommand"]][] = [
    ["`herdr agent list` fails", (fake) => async (argv, o) => argv[0] === "herdr" && argv[2] === "list" ? { exitCode: 1, stdout: "", stderr: "herdr server not running" } : fake.runCommand(argv, o)],
    ["`claude agents --json` exits non-zero", (fake) => async (argv, o) => argv[0] === "claude" && argv[1] === "agents" ? { exitCode: 1, stdout: "", stderr: "not logged in" } : fake.runCommand(argv, o)],
  ];
  for (const [label, failing] of failures) {
    test(`never treated as 'nothing running'; no restore is issued — ${label}`, async () => {
      const dir = await makeTempDir();
      const key = "/claimed/dir" as ClaimKey;
      await saveClaims(join(dir, "claims.json"), claim(emptyStore(), key, 1).state);
      await saveAgents(join(dir, "agents.json"), putAgent(emptyAgentStore(), makeAgent({ id: "@a1", directory: key, birthSessionId: "session-on-record", restoreTarget: { sessionId: "session-on-record", shortId: "session-" } })));

      const fake = makeNoStopHost();
      const deps = baseDeps(dir, failing(fake));

      const result = await runReconcileCycle(initialDaemonState(), deps);
      expect(result.skippedListingFailed).toBe(true);
      expect(result.restored).toEqual([]);
      expect(fake.starts()).toEqual([]);
      expect(createdCwds(fake.calls)).toEqual([]);

      const reloaded = await loadAgents(join(dir, "agents.json"));
      expect(reloaded.status).toBe("loaded");
      if (reloaded.status === "loaded") expect(reloaded.state.agents["@a1"]?.birthSessionId).toBe("session-on-record");
    });
  }
});

describe("AC2 (herdr REWRITE of BAKR-22): restore is silent and exact — the restore argv resumes the SAME session id, never forks, and carries only launch-config flags (never a permissions or model flag)", () => {
  test("through the real reconcile cycle against a migrated store (stubbed herdr/claude — proves what bakr constructs and passes, nothing about the real binary)", async () => {
    const dir = await makeTempDir();
    const key = "/claimed/dir" as ClaimKey;
    await saveClaims(join(dir, "claims.json"), claim(emptyStore(), key, 1).state);
    let slots = emptySessionSlots();
    slots = beginLaunch(slots, key, undefined, "seed", 1);
    slots = markLaunchStarted(slots, "seed", "seed-short");
    slots = resolveLaunch(slots, "seed-short", "old-session-id");
    await writeFile(join(dir, "session-slots.json"), serializeSessionSlotsState(slots), "utf8");

    const fake = makeNoStopHost();
    const deps = baseDeps(dir, fake.runCommand);

    const result = await runReconcileCycle(initialDaemonState(), deps);
    expect(result.restored).toHaveLength(1);
    expect(fake.starts()).toHaveLength(1);
    const restore = fake.starts()[0]!;
    // FALSIFIER: bakr's restore argv must NEVER carry a permissions or model
    // flag (BAKR-22 showed those make a resume fork), and must never fork or
    // mint a session of its own. This fixture's directory configures no MCP
    // servers, so launch-config contributes no flags: the restore is EXACTLY
    // a resume of the durable session id and nothing else.
    expect(restore).toEqual(["--resume", "old-session-id"]);
    expect(restore).not.toContain("--fork-session");
    expect(restore).not.toContain("--session-id");
    expect(restore.some((a) => /^--(model|permission-mode|dangerously-skip-permissions|allowedTools|allowed-tools)/.test(a))).toBe(false);
  });
});

describe("AC3: only 'on' is restored — off and archived are NEVER launched, with the negative control that 'on' IS", () => {
  test("one directory holding on/off/archived agents, across several cycles", async () => {
    const dir = await makeTempDir();
    const key = "/claimed/dir" as ClaimKey;
    await saveClaims(join(dir, "claims.json"), claim(emptyStore(), key, 1).state);
    let store = emptyAgentStore();
    store = putAgent(store, makeAgent({ id: "@on-agent", directory: key, state: "on" }));
    store = putAgent(store, makeAgent({ id: "@off-agent", directory: key, state: "off" }));
    store = putAgent(store, makeAgent({ id: "@archived-agent", directory: key, state: "archived" }));
    await saveAgents(join(dir, "agents.json"), store);

    const fake = makeNoStopHost(); // throws if a `claude stop` is ever issued
    const deps = baseDeps(dir, fake.runCommand);

    let state = initialDaemonState();
    for (let i = 0; i < 3; i++) {
      const result = await runReconcileCycle(state, deps);
      state = { claimDegraded: result.claimDegraded, agentsDegraded: result.agentsDegraded, orphanReportSignatures: result.orphanReportSignatures };
    }

    const final = await loadAgents(join(dir, "agents.json"));
    expect(final.status).toBe("loaded");
    if (final.status === "loaded") {
      expect(final.state.agents["@off-agent"]?.birthSessionId).toBeUndefined();
      expect(final.state.agents["@archived-agent"]?.birthSessionId).toBeUndefined();
      // NEGATIVE CONTROL: the on-agent DID get launched — proves the run can observe a launch at all.
      expect(final.state.agents["@on-agent"]?.birthSessionId).toBeDefined();
    }
  });
});

describe("a reconcile's own fresh launch carries a channel for every server the directory configures", () => {
  test("an agent whose directory configures a requested server is launched subscribed to it", async () => {
    const dir = await makeTempDir();
    const key = "/claimed/dir" as ClaimKey;
    await saveClaims(join(dir, "claims.json"), claim(emptyStore(), key, 1).state);
    await saveAgents(join(dir, "agents.json"), putAgent(emptyAgentStore(), makeAgent({ id: "@coordinator", directory: key, state: "on", restoreTarget: undefined })));

    const fake = makeNoStopHost();
    const events: string[] = [];
    const settingsIo = memorySettings(events);
    const result = await runReconcileCycle(initialDaemonState(), {
      ...baseDeps(dir, async (argv, opts) => { if (argv[0] === "herdr" && argv[2] === "start") events.push("start"); return fake.runCommand(argv, opts); }),
      launchConfigDeps: {
        readConfigFile: async (path) => path === `${key}/.mcp.json`
          ? JSON.stringify({ mcpServers: { yappr: { type: "stdio", command: "bun" } } })
          : undefined,
        settingsIo,
      },
    });
    expect(result.restored).toHaveLength(1);
    // Approved BEFORE the launch: Claude reads it at process start.
    const approval = `${key}/.claude/settings.local.json`;
    expect(JSON.parse(settingsIo.files[approval]!).enabledMcpjsonServers).toEqual(["yappr"]);
    expect(events).toEqual([`write ${approval}`, "start"]);

    expect(fake.starts()).toHaveLength(1);
    const [flag, sessionId, ...rest] = fake.starts()[0]!;
    // A fresh launch names its own session first; everything after it is launch-config's.
    expect(flag).toBe("--session-id");
    expect(sessionId).toBeTruthy();
    // FALSIFIER: the daemon is what keeps these sessions alive, so a launch it
    // issues without the channel is the reported bug, not a lesser version of it.
    expect(rest).toEqual([
      "--mcp-config", `${key}/.mcp.json`,
      "--settings", JSON.stringify({ enabledMcpjsonServers: ["yappr"] }),
      "--dangerously-load-development-channels=server:yappr",
    ]);
  });
});

describe("a restore carries its agent's CURRENT launch flags, with its MCP approval in place first", () => {
  test("an agent's own declaration is approved before the resumed pane starts, and the resume carries exactly that declaration's flags", async () => {
    const dir = await makeTempDir();
    const key = "/claimed/dir" as ClaimKey;
    await saveClaims(join(dir, "claims.json"), claim(emptyStore(), key, 1).state);
    await saveAgents(join(dir, "agents.json"), putAgent(emptyAgentStore(), {
      ...makeAgent({ id: "@rocketr", directory: key, state: "on", restoreTarget: { sessionId: "old-session-id", shortId: "old-sess" } }),
      mcp: [{ name: "rocketr", notifications: true }],
    }));

    const fake = makeNoStopHost();
    const events: string[] = [];
    const settingsIo = memorySettings(events);
    const result = await runReconcileCycle(initialDaemonState(), {
      ...baseDeps(dir, async (argv, opts) => { if (argv[0] === "herdr" && argv[2] === "start") events.push("start"); return fake.runCommand(argv, opts); }),
      launchConfigDeps: {
        readConfigFile: async () => JSON.stringify({ mcpServers: { rocketr: {}, yappr: {} } }),
        settingsIo,
      },
    });
    expect(result.restored).toHaveLength(1);
    // The SAME session, resumed (never forked), with the agent's own declaration — not the host default (yappr).
    expect(fake.starts()).toEqual([[
      "--resume", "old-session-id",
      "--mcp-config", `${key}/.mcp.json`,
      "--settings", JSON.stringify({ enabledMcpjsonServers: ["rocketr"] }),
      "--dangerously-load-development-channels=server:rocketr",
    ]]);
    const approval = `${key}/.claude/settings.local.json`;
    expect(JSON.parse(settingsIo.files[approval]!).enabledMcpjsonServers).toEqual(["rocketr"]);
    expect(events).toEqual([`write ${approval}`, "start"]);
  });
});

describe("AC4 (HEADLINE): fresh-launch resolution by agent, not directory", () => {
  test("two agents launched fresh into the SAME directory in the SAME cycle each end up holding their own session", async () => {
    const dir = await makeTempDir();
    const key = "/claimed/dir" as ClaimKey;
    await saveClaims(join(dir, "claims.json"), claim(emptyStore(), key, 1).state);
    let store = emptyAgentStore();
    store = putAgent(store, makeAgent({ id: "@agent-1", directory: key, state: "on", restoreTarget: undefined }));
    store = putAgent(store, makeAgent({ id: "@agent-2", directory: key, state: "on", restoreTarget: undefined }));
    await saveAgents(join(dir, "agents.json"), store);

    const fake = makeNoStopHost();
    const deps = baseDeps(dir, fake.runCommand);

    // Cycle 1: both fresh launches issued.
    const result1 = await runReconcileCycle(initialDaemonState(), deps);
    expect(result1.restored).toHaveLength(2);
    expect(new Set(result1.restored.map((r) => r.agentId))).toEqual(new Set(["@agent-1", "@agent-2"]));

    // Cycle 2: the listing now includes both launched panes -> both resolve, EACH to its own agent.
    await runReconcileCycle(nextState(result1), deps);

    const final = await loadAgents(join(dir, "agents.json"));
    expect(final.status).toBe("loaded");
    if (final.status === "loaded") {
      const a1 = final.state.agents["@agent-1"];
      const a2 = final.state.agents["@agent-2"];
      expect(a1?.birthSessionId).toBeDefined();
      expect(a2?.birthSessionId).toBeDefined();
      expect(a1?.birthSessionId).not.toBe(a2?.birthSessionId); // distinct sessions, correctly attributed
      // Each agent holds the session ITS OWN pane runs — attribution by pane, never by directory.
      for (const agent of [a1!, a2!]) {
        const pane = fake.panes.find((p) => p.paneId === agent.restoreTarget?.shortId);
        expect(pane?.sessionId).toBe(agent.birthSessionId!);
      }
    }
  });
});

describe("herdr REWRITE of BAKR-22: the full silent-restore lifecycle (birth id and the restore target's SESSION id never rotate on an ordinary restore; only the pane handle moves)", () => {
  test("an on-record session absent from a successful listing is restored via `--resume <sessionId>` in a new pane; the session id does NOT change, the short id becomes the new pane", async () => {
    const dir = await makeTempDir();
    const key = "/claimed/dir" as ClaimKey;
    await saveClaims(join(dir, "claims.json"), claim(emptyStore(), key, 1).state);
    await saveAgents(join(dir, "agents.json"), putAgent(emptyAgentStore(), makeAgent({ id: "@a1", directory: key, birthSessionId: "old-session-id", restoreTarget: { sessionId: "old-session-id", shortId: "old-sessi" } })));

    const fake = makeNoStopHost();
    const deps = baseDeps(dir, fake.runCommand);

    const result1 = await runReconcileCycle(initialDaemonState(), deps);
    expect(result1.restored).toEqual([{ agentId: "@a1", key, sessionId: "old-session-id" }]);
    expect(fake.starts()).toEqual([["--resume", "old-session-id"]]);
    expect(fake.panes.map((p) => [p.cwd, p.sessionId])).toEqual([[key, "old-session-id"]]);

    const afterCycle1 = await loadAgents(join(dir, "agents.json"));
    if (afterCycle1.status === "loaded") expect(afterCycle1.state.agents["@a1"]?.birthSessionId).toBe("old-session-id");

    const result2 = await runReconcileCycle(nextState(result1), deps);
    expect(result2.restored).toEqual([]); // now verifiably alive (the resumed pane lists this process's own pid) — not restored again
    expect(fake.starts()).toHaveLength(1);

    const afterCycle2 = await loadAgents(join(dir, "agents.json"));
    expect(afterCycle2.status).toBe("loaded");
    if (afterCycle2.status === "loaded") {
      const agent = afterCycle2.state.agents["@a1"];
      expect(agent?.birthSessionId).toBe("old-session-id"); // UNCHANGED
      // The session id is UNCHANGED — no rotation; only the handle moved to the pane now hosting it.
      expect(agent?.restoreTarget).toEqual({ sessionId: "old-session-id", shortId: fake.panes[0]!.paneId });
      expect(afterCycle2.state.launches).toEqual([]); // the restore attempt resolved, nothing left pending
    }
  });

  test("a session already alive in a herdr pane (verifiably-alive pid) is never restored — found by its SESSION id even though the pane id differs from the recorded short id", async () => {
    const dir = await makeTempDir();
    const key = "/claimed/dir" as ClaimKey;
    await saveClaims(join(dir, "claims.json"), claim(emptyStore(), key, 1).state);
    await saveAgents(join(dir, "agents.json"), putAgent(emptyAgentStore(), makeAgent({ id: "@a1", directory: key, birthSessionId: "live-session-id", restoreTarget: { sessionId: "live-session-id", shortId: "short-live" } })));

    const fake = makeNoStopHost();
    fake.addPane({ cwd: key, sessionId: "live-session-id" });
    const result = await runReconcileCycle(initialDaemonState(), baseDeps(dir, fake.runCommand));
    expect(result.restored).toEqual([]);
    expect(fake.starts()).toEqual([]);
  });

  test("a session already alive as a LEGACY background session (listed by `claude agents --json` with a verifiably-alive pid) is never restored into a second process", async () => {
    const dir = await makeTempDir();
    const key = "/claimed/dir" as ClaimKey;
    await saveClaims(join(dir, "claims.json"), claim(emptyStore(), key, 1).state);
    await saveAgents(join(dir, "agents.json"), putAgent(emptyAgentStore(), makeAgent({ id: "@a1", directory: key, birthSessionId: "live-session-id", restoreTarget: { sessionId: "live-session-id", shortId: "short-live" } })));

    const fake = makeNoStopHost();
    fake.legacy.push({ id: "short-live", sessionId: "live-session-id", cwd: key, startedAt: 1, kind: "background", pid: process.pid });
    const result = await runReconcileCycle(initialDaemonState(), baseDeps(dir, fake.runCommand));
    expect(result.restored).toEqual([]);
    expect(fake.starts()).toEqual([]);
  });

  test("NEGATIVE CONTROL: the identical agent with NOTHING listed for its session IS restored — proves the two refusals above are 'correctly found alive', not 'never restores'", async () => {
    const dir = await makeTempDir();
    const key = "/claimed/dir" as ClaimKey;
    await saveClaims(join(dir, "claims.json"), claim(emptyStore(), key, 1).state);
    await saveAgents(join(dir, "agents.json"), putAgent(emptyAgentStore(), makeAgent({ id: "@a1", directory: key, birthSessionId: "live-session-id", restoreTarget: { sessionId: "live-session-id", shortId: "short-live" } })));

    const fake = makeNoStopHost();
    fake.addPane({ cwd: key, sessionId: "someone-elses-session" });
    const result = await runReconcileCycle(initialDaemonState(), baseDeps(dir, fake.runCommand));
    expect(result.restored).toHaveLength(1);
    expect(fake.starts()).toEqual([["--resume", "live-session-id"]]);
  });
});

describe("herdr REWRITE of BAKR-22: every restore resumes the SAME session id — it never drifts to another session, and a give-up still converges", () => {
  test("every restore attempt across many cycles resumes the identical session id, never forking or minting, and gives up after MAX_CONSECUTIVE_UNVERIFIED_RESTORES if it never becomes verifiably alive", async () => {
    const dir = await makeTempDir();
    const key = "/claimed/dir" as ClaimKey;
    await saveClaims(join(dir, "claims.json"), claim(emptyStore(), key, 1).state);
    const SESSION_ID = "03df9926-durable-conversation";
    await saveAgents(join(dir, "agents.json"), putAgent(emptyAgentStore(), makeAgent({ id: "@a1", directory: key, birthSessionId: SESSION_ID, restoreTarget: { sessionId: SESSION_ID, shortId: "durabl-1" } })));

    // This session NEVER stays visible in a listing: each resumed pane exits
    // before the next cycle (a silently-failing resume). The daemon must still
    // resume only ever this one session id, never invent or drift to another,
    // and must eventually give up rather than retry unboundedly.
    const fake = makeNoStopHost();
    const deps = baseDeps(dir, fake.runCommand);
    let state = initialDaemonState();
    for (let i = 0; i < 8; i++) {
      const result = await runReconcileCycle(state, deps);
      state = nextState(result);
      fake.panes.length = 0;
    }

    expect(fake.starts().length).toBeGreaterThan(0);
    for (const args of fake.starts()) {
      expect(args).toEqual(["--resume", SESSION_ID]); // never drifts to any other session, never forks, never mints
    }
    // Converges: MAX_CONSECUTIVE_UNVERIFIED_RESTORES bounds the attempts, then the give-up record blocks further ones.
    expect(fake.starts().length).toBeLessThanOrEqual(3);

    const finalState = await loadAgents(join(dir, "agents.json"));
    expect(finalState.status).toBe("loaded");
    if (finalState.status === "loaded") {
      expect(finalState.state.agents["@a1"]?.birthSessionId).toBe(SESSION_ID);
      expect(finalState.state.agents["@a1"]?.restoreTarget?.sessionId).toBe(SESSION_ID);
    }
  });
});

describe("regression: a restore that 'succeeds' but never becomes independently verifiable must not loop forever (convergence)", () => {
  test("every resumed pane reaches idle but is gone from the next listing — the daemon must converge", async () => {
    const dir = await makeTempDir();
    const key = "/claimed/dir" as ClaimKey;
    await saveClaims(join(dir, "claims.json"), claim(emptyStore(), key, 1).state);
    await saveAgents(join(dir, "agents.json"), putAgent(emptyAgentStore(), makeAgent({ id: "@a1", directory: key, birthSessionId: "seed-session-id", restoreTarget: { sessionId: "seed-session-id", shortId: "seed-sess" } })));

    const fake = makeNoStopHost();
    const deps = baseDeps(dir, fake.runCommand);
    const cycle = async (s: ReturnType<typeof initialDaemonState>) => {
      const result = await runReconcileCycle(s, deps);
      fake.panes.length = 0; // never listed next cycle — always "absent", never "alive"
      return nextState(result);
    };
    let state = initialDaemonState();
    for (let i = 0; i < 10; i++) state = await cycle(state);

    expect(fake.restores().length).toBeLessThanOrEqual(3);
    expect(fake.restores().length).toBeGreaterThan(0);

    const finalState = await loadAgents(join(dir, "agents.json"));
    expect(finalState.status).toBe("loaded");
    if (finalState.status === "loaded") expect(unresolvedLaunches(finalState.state).length).toBeGreaterThan(0);

    const restoresAtConvergence = fake.restores().length;
    for (let i = 0; i < 5; i++) state = await cycle(state);
    expect(fake.restores().length).toBe(restoresAtConvergence); // still converged — no further attempts once given up
  });
});

describe("regression (PR #7 review, ported): a crash mid-launch must not silently wedge a session's restore forever", () => {
  test("a record left with no launchShortId and no error is recovered, logged, and never silently blocks restore going forward", async () => {
    const dir = await makeTempDir();
    const key = "/claimed/dir" as ClaimKey;
    await saveClaims(join(dir, "claims.json"), claim(emptyStore(), key, 1).state);
    let store = putAgent(emptyAgentStore(), makeAgent({ id: "@a1", directory: key, birthSessionId: "stale-prior-session", restoreTarget: { sessionId: "stale-prior-session", shortId: "stale-pri" } }));
    store = { ...store, launches: [{ attemptId: "wedged-attempt", agentId: "@a1", key, attemptKey: { kind: "respawn", shortId: "stale-pri" }, attemptedAt: 1000, launchShortId: undefined, error: undefined }] };
    await saveAgents(join(dir, "agents.json"), store);

    const fake = makeNoStopHost();
    const deps = baseDeps(dir, fake.runCommand);

    const result = await runReconcileCycle(initialDaemonState(), deps);
    expect(result.skippedListingFailed).toBe(false); // the listing succeeded — the zero launches below are the block, not a skipped cycle

    const reloadedAfter = await loadAgents(join(dir, "agents.json"));
    expect(reloadedAfter.status).toBe("loaded");
    if (reloadedAfter.status === "loaded") {
      expect(unresolvedLaunches(reloadedAfter.state)).toHaveLength(1);
      expect(unresolvedLaunches(reloadedAfter.state)[0]?.error).toMatch(/ended before this launch's outcome was recorded/);
    }
    expect(fake.starts()).toEqual([]); // never auto-retried — still blocked by the promoted (now errored) record
    expect(result.restored).toEqual([]);
  });
});

describe("Constraint 2: a failed launch is recorded, never retried automatically", () => {
  test("across repeated cycles, the failed restore is logged but launch() is called exactly once", async () => {
    const dir = await makeTempDir();
    const key = "/claimed/dir" as ClaimKey;
    await saveClaims(join(dir, "claims.json"), claim(emptyStore(), key, 1).state);
    await saveAgents(join(dir, "agents.json"), putAgent(emptyAgentStore(), makeAgent({ id: "@a1", directory: key, birthSessionId: "old-session-id", restoreTarget: { sessionId: "old-session-id", shortId: "old-sessi" } })));

    // A failed start abandons (closes) its own half-made workspace, so this uses the plain fake, not the no-stop one.
    const fake = makeFakeHost({ failStart: "No conversation found with session ID: old-session-id" });
    const deps = baseDeps(dir, fake.runCommand);

    const result1 = await runReconcileCycle(initialDaemonState(), deps);
    expect(result1.restored).toEqual([]);
    expect(fake.starts()).toHaveLength(1);

    const result2 = await runReconcileCycle(nextState(result1), deps);
    expect(result2.restored).toEqual([]);
    expect(fake.starts()).toHaveLength(1);

    const final = await loadAgents(join(dir, "agents.json"));
    expect(final.status).toBe("loaded");
    if (final.status === "loaded") expect(unresolvedLaunches(final.state).map((l) => l.error)).toEqual([expect.stringContaining("No conversation found")]);
  });
});

describe("AC14: a given-up (errored) v1 launch record must keep blocking its migrated agent's restore, with the negative control that a HEALTHY migrated agent IS restored", () => {
  test("migration attributes the errored record to the correct agent via the durableSessionId->agentId correspondence, and that block survives across many cycles", async () => {
    const dir = await makeTempDir();
    const key = "/claimed/dir" as ClaimKey;
    await saveClaims(join(dir, "claims.json"), claim(emptyStore(), key, 1).state);

    let slots = emptySessionSlots();
    // A HEALTHY on-slot.
    slots = beginLaunch(slots, key, undefined, "healthy-seed", 1);
    slots = markLaunchStarted(slots, "healthy-seed", "healthy-short");
    slots = resolveLaunch(slots, "healthy-short", "healthy-durable-id");
    // A SECOND, healthy on-slot whose restore was given up on (error set) before migration.
    slots = beginLaunch(slots, key, undefined, "given-up-seed", 1);
    slots = markLaunchStarted(slots, "given-up-seed", "given-up-short");
    slots = resolveLaunch(slots, "given-up-short", "given-up-durable-id");
    slots = beginLaunch(slots, key, "given-up-durable-id", "given-up-restore-attempt", 2000);
    slots = markLaunchFailed(slots, "given-up-restore-attempt", "gave up after 3 consecutive restore attempts — pre-migration");
    await writeFile(join(dir, "session-slots.json"), serializeSessionSlotsState(slots), "utf8");

    const fake = makeNoStopHost(); // empty listing every cycle -> both agents look "absent", so the block is the only thing stopping a relaunch of the given-up one
    const deps = baseDeps(dir, fake.runCommand);

    let state = initialDaemonState();
    let cycles: Awaited<ReturnType<typeof runReconcileCycle>>[] = [];
    for (let i = 0; i < 5; i++) {
      const result = await runReconcileCycle(state, deps);
      cycles.push(result);
      state = { claimDegraded: result.claimDegraded, agentsDegraded: result.agentsDegraded, orphanReportSignatures: result.orphanReportSignatures };
    }

    const finalState = await loadAgents(join(dir, "agents.json"));
    expect(finalState.status).toBe("loaded");
    if (finalState.status !== "loaded") return;

    const healthyAgent = Object.values(finalState.state.agents).find((a) => a.birthSessionId === "healthy-durable-id");
    const givenUpAgent = Object.values(finalState.state.agents).find((a) => a.birthSessionId === "given-up-durable-id");
    expect(healthyAgent).toBeDefined();
    expect(givenUpAgent).toBeDefined();

    // The given-up agent's block SURVIVED the migration: zero launches for it across every cycle.
    const allRestoredAgentIds = cycles.flatMap((c) => c.restored.map((r) => r.agentId));
    expect(allRestoredAgentIds).not.toContain(givenUpAgent!.id);
    // NEGATIVE CONTROL: the healthy migrated agent WAS restored — without this, the check above can't tell "correctly blocked" from "launched nothing at all".
    expect(allRestoredAgentIds).toContain(healthyAgent!.id);

    // And the given-up record itself is still on record, unresolved, still attributed to the right agent.
    const stillUnresolved = unresolvedLaunches(finalState.state).find((l) => l.agentId === givenUpAgent!.id);
    expect(stillUnresolved).toBeDefined();
  });
});

describe("BAKR-24 Q4: report, don't launch — an orphaned claim's on-agents are never launched, and never create a launch record", () => {
  test("real directories: a claim whose directory is DELETED gets zero launches over several cycles; the NEGATIVE CONTROL — an ordinary 'on' agent in a directory that still resolves — IS launched in the SAME run; the report names the missing directory, not systemd-run", async () => {
    const storeDir = await makeTempDir();
    const presentDir = await mkdtemp(join(tmpdir(), "bakr-q4-present-"));
    cleanupDirs.push(presentDir);
    const goneDirParent = await mkdtemp(join(tmpdir(), "bakr-q4-gone-parent-"));
    cleanupDirs.push(goneDirParent);
    const goneDir = join(goneDirParent, "moved-away") as ClaimKey;
    await mkdir(goneDir);
    // Delete it BEFORE any reconcile cycle runs — a genuine orphan from cycle 1.
    await rm(goneDir, { recursive: true, force: true });

    const presentKey = presentDir as ClaimKey;

    let claimState = emptyStore();
    claimState = claim(claimState, presentKey, 1).state;
    claimState = claim(claimState, goneDir, 1).state;
    await saveClaims(join(storeDir, "claims.json"), claimState);

    let agentState = emptyAgentStore();
    agentState = putAgent(agentState, makeAgent({ id: "@present-agent", directory: presentKey }));
    agentState = putAgent(agentState, makeAgent({ id: "@orphan-agent", directory: goneDir }));
    await saveAgents(join(storeDir, "agents.json"), agentState);

    const fake = makeNoStopHost();
    const deps: DaemonDeps = { ...baseDeps(storeDir, fake.runCommand), probeDeps: realOrphanProbeDeps };

    const capturedLines: string[] = [];
    const originalConsoleLog = console.log;
    console.log = (...args: unknown[]) => {
      capturedLines.push(args.map(String).join(" "));
    };
    let state = initialDaemonState();
    try {
      for (let i = 0; i < 3; i++) {
        const result = await runReconcileCycle(state, deps);
        state = { claimDegraded: result.claimDegraded, agentsDegraded: result.agentsDegraded, orphanReportSignatures: result.orphanReportSignatures };
      }
    } finally {
      console.log = originalConsoleLog;
    }

    // The orphan was NEVER launched, across every cycle.
    const launchedCwds = createdCwds(fake.calls);
    expect(launchedCwds).not.toContain(goneDir);
    // NEGATIVE CONTROL: the present-directory agent WAS launched in this same run — proves the harness can observe a launch at all, so the zero above means "correctly skipped", not "launched nothing anywhere".
    expect(launchedCwds).toContain(presentDir);

    // No launch record was ever created for the orphaned agent (Q4: "create no launch record at all").
    const finalAgents = await loadAgents(join(storeDir, "agents.json"));
    expect(finalAgents.status).toBe("loaded");
    if (finalAgents.status === "loaded") {
      expect(finalAgents.state.launches.some((l) => l.agentId === "@orphan-agent")).toBe(false);
    }

    // The report names the missing directory and the agent, and does NOT echo a systemd-run/ENOENT-shaped explanation.
    const orphanLogLines = capturedLines.filter((line) => line.includes("@orphan-agent"));
    expect(orphanLogLines.length).toBeGreaterThan(0);
    expect(orphanLogLines[0]).toContain(goneDir);
    expect(orphanLogLines[0]).toMatch(/verdict: gone/);
    expect(orphanLogLines[0]).not.toMatch(/posix_spawn|systemd-run:/);

    // Reported on STATE CHANGE only, not once per cycle — 3 cycles, but the orphan's status never changed after cycle 1, so exactly one report line for it.
    expect(orphanLogLines).toHaveLength(1);
  });

  test("REVIEW FINDING: a PRE-EXISTING unresolved launch record (left by a daemon version that predates Q4) for an agent whose directory is now gone must not keep logging at error level every cycle forever — the orphan report is the single voice instead", async () => {
    const storeDir = await makeTempDir();
    const goneDirParent = await mkdtemp(join(tmpdir(), "bakr-q4-stale-record-parent-"));
    cleanupDirs.push(goneDirParent);
    const goneDir = join(goneDirParent, "moved-away") as ClaimKey;
    await mkdir(goneDir);
    await rm(goneDir, { recursive: true, force: true });

    await saveClaims(join(storeDir, "claims.json"), claim(emptyStore(), goneDir, 1).state);

    let agentState = putAgent(emptyAgentStore(), makeAgent({ id: "@stale-agent", directory: goneDir, birthSessionId: "durable-x", restoreTarget: { sessionId: "durable-x", shortId: "durable-x" } }));
    // Simulate a PRE-EXISTING failed launch record from before this daemon version shipped — exactly what a daemon upgrade finds already sitting in the store for an agent that was orphaned under the OLD code.
    agentState = { ...agentState, launches: [{ attemptId: "pre-existing-attempt", agentId: "@stale-agent", key: goneDir, attemptKey: { kind: "respawn", shortId: "durable-x" }, attemptedAt: 1, launchShortId: undefined, error: "gave up after 3 consecutive restore attempts — left by a pre-Q4 daemon" }] };
    await saveAgents(join(storeDir, "agents.json"), agentState);

    const deps: DaemonDeps = { ...baseDeps(storeDir, makeNoStopHost().runCommand), probeDeps: realOrphanProbeDeps };

    const capturedLines: string[] = [];
    const originalConsoleLog = console.log;
    console.log = (...args: unknown[]) => {
      capturedLines.push(args.map(String).join(" "));
    };
    let state = initialDaemonState();
    try {
      for (let i = 0; i < 4; i++) {
        const result = await runReconcileCycle(state, deps);
        state = { claimDegraded: result.claimDegraded, agentsDegraded: result.agentsDegraded, orphanReportSignatures: result.orphanReportSignatures };
      }
    } finally {
      console.log = originalConsoleLog;
    }

    const unresolvedLogLines = capturedLines.filter((line) => line.includes("unresolved launch for agent @stale-agent"));
    expect(unresolvedLogLines).toEqual([]); // suppressed — the orphan report below is the single voice

    const orphanReportLines = capturedLines.filter((line) => line.includes("@stale-agent") && line.includes(goneDir));
    expect(orphanReportLines).toHaveLength(1); // once per state change, not once per cycle

    // NEGATIVE CONTROL: the identical stale record, for an agent in a directory that still resolves, is NOT suppressed — proves the suppression is keyed on classification, not on "any unresolved record ever".
    const presentDir = await mkdtemp(join(tmpdir(), "bakr-q4-stale-record-present-"));
    cleanupDirs.push(presentDir);
    const storeDir2 = await makeTempDir();
    await saveClaims(join(storeDir2, "claims.json"), claim(emptyStore(), presentDir as ClaimKey, 1).state);
    let agentState2 = putAgent(emptyAgentStore(), makeAgent({ id: "@healthy-agent", directory: presentDir as ClaimKey, birthSessionId: "durable-y", restoreTarget: { sessionId: "durable-y", shortId: "durable-y" } }));
    agentState2 = { ...agentState2, launches: [{ attemptId: "pre-existing-attempt-2", agentId: "@healthy-agent", key: presentDir as ClaimKey, attemptKey: { kind: "respawn", shortId: "durable-y" }, attemptedAt: 1, launchShortId: undefined, error: "gave up after 3 consecutive restore attempts — unrelated to any directory move" }] };
    await saveAgents(join(storeDir2, "agents.json"), agentState2);
    const deps2: DaemonDeps = { ...baseDeps(storeDir2, makeNoStopHost().runCommand), probeDeps: realOrphanProbeDeps };
    const capturedLines2: string[] = [];
    console.log = (...args: unknown[]) => {
      capturedLines2.push(args.map(String).join(" "));
    };
    try {
      await runReconcileCycle(initialDaemonState(), deps2);
      await runReconcileCycle(initialDaemonState(), deps2);
    } finally {
      console.log = originalConsoleLog;
    }
    const healthyUnresolvedLines = capturedLines2.filter((line) => line.includes("unresolved launch for agent @healthy-agent"));
    expect(healthyUnresolvedLines).toHaveLength(2); // unsuppressed, unconditional, every cycle — unchanged Constraint 2 behaviour for a genuinely non-orphaned directory
  });
});
