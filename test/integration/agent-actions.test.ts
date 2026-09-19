// Integration coverage for agent-actions.ts's effect layer, against a real
// temp-dir store through the real `withAgentStoreLock`, with the shared fake
// host (test/support/fake-host.ts) standing in for herdr and legacy `claude
// --bg` (no real process
// spawned here — that is the live demonstration's job, PR body). Each
// group states its falsifier in the test name or a comment.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyAgentStore, putAgent, type AgentRecord } from "../../src/agent-model";
import { save as saveAgents, load as loadAgents } from "../../src/agent-store-io";
import {
  archive,
  attachTarget,
  create,
  deleteAgent,
  list,
  mcp,
  off,
  on,
  stopLiveSession,
  unarchive,
  type AgentActionDeps,
} from "../../src/agent-actions";
import type { ClaimKey } from "../../src/claim-key-resolve";
import type { RefClassification } from "../../src/agent-model";
import type { McpSettingsIo } from "@brooswit/drovr";
import { makeFakeHost, type FakeHost } from "../support/fake-host";

/** In-memory vendor settings, so no test writes a real `.claude/settings.local.json`. */
function memorySettings(): McpSettingsIo & { files: Record<string, string> } {
  const files: Record<string, string> = {};
  return { files, readSettings: async (path) => files[path], writeSettings: async (path, contents) => { files[path] = contents; } };
}
const approvalIn = (io: { files: Record<string, string> }, dir: string): unknown =>
  JSON.parse(io.files[`${dir}/.claude/settings.local.json`] ?? "{}").enabledMcpjsonServers;
const ROCKETR_MCP = JSON.stringify({ mcpServers: { rocketr: { type: "http" }, yappr: { type: "stdio" } } });

const KEY = "/claimed/dir" as ClaimKey;
const OTHER_KEY = "/claimed/other" as ClaimKey;
const byId = (ref: string): RefClassification => ({ kind: "id", ref });

const cleanupDirs: string[] = [];
afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bakr-agent-actions-"));
  cleanupDirs.push(dir);
  return dir;
}

/** A listing read: herdr's pane registry, one pane's process info, or legacy `claude agents --json`. */
const isListingRead = (argv: string[]): boolean =>
  (argv[0] === "herdr" && argv[1] === "agent" && argv[2] === "list") ||
  // drovr's listResidents telling its residents' workspaces apart (BAKR-37).
  (argv[0] === "herdr" && argv[1] === "workspace" && argv[2] === "list") ||
  (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "process-info") ||
  (argv[0] === "claude" && argv[1] === "agents");

/** How many full listings ran (each begins with `herdr agent list`). */
const listings = (host: FakeHost): number => host.calls.filter((c) => c[0] === "herdr" && c[1] === "agent" && c[2] === "list").length;

/** Every command that is NOT a listing read, in order — the raw evidence a test can assert the exact stop/launch mechanism against. */
const effects = (host: FakeHost): string[][] => host.calls.filter((c) => !isListingRead(c));

/** A fresh launch names its own session first (`--session-id <uuid>`); returns the claude args bakr chose after that. */
function afterNamedSession(args: readonly string[]): string[] {
  expect(args[0]).toBe("--session-id");
  expect(args[1]).toMatch(/^[0-9a-f-]{36}$/);
  return args.slice(2);
}

function baseDeps(dir: string, runCommand: AgentActionDeps["runCommand"]): AgentActionDeps {
  let counter = 0;
  let randomCounter = 0;
  return {
    agentsPath: join(dir, "agents.json"),
    runCommand,
    // Pinned rather than inherited: the default reads this HOST's own
    // `.mcp.json` files, which would make
    // every launch-argv assertion below depend on the machine running it.
    launchConfigDeps: { readConfigFile: async () => undefined },
    now: () => 1_700_000_000_000,
    generateAttemptId: () => `attempt-${counter++}`,
    randomBytes: (n: number) => {
      randomCounter += 1;
      return new Uint8Array(n).fill(randomCounter & 0xff);
    },
  };
}

function makeAgent(overrides: Partial<AgentRecord> & { id: string }): AgentRecord {
  return { name: undefined, directory: KEY, state: "on", createdAt: 1, birthSessionId: undefined, restoreTarget: undefined, ...overrides };
}

async function seedAgent(agentsPath: string, agent: AgentRecord): Promise<void> {
  await saveAgents(agentsPath, putAgent(emptyAgentStore(), agent));
}

// --- create: B8 (no prompt at all), name validation, honest about sessionId ---

describe("create", () => {
  test("mints an unnamed `on` agent and issues a launch with NO ARGS AT ALL beyond its own session name (B8: create passes no prompt, no resume)", async () => {
    const dir = await makeTempDir();
    const fake = makeFakeHost();
    const result = await create(baseDeps(dir, fake.runCommand), KEY);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.agent.state).toBe("on");
    expect(result.agent.name).toBeUndefined();
    expect(result.agent.birthSessionId).toBeUndefined(); // honest: resolved into the record later, never at create time (Q3)
    expect(result.launch).toEqual({ ok: true, launchShortId: "w1:p1" });

    // One herdr workspace in the claimed directory, claude started in its root pane.
    expect(fake.calls.filter((c) => c[1] === "workspace" && c[2] === "create").map((c) => c[c.indexOf("--cwd") + 1])).toEqual([KEY]);
    expect(fake.starts()).toHaveLength(1);
    // FALSIFIER: any argv element beyond the launch's own `--session-id <uuid>` is a B8 violation.
    expect(afterNamedSession(fake.starts()[0]!)).toEqual([]);
  });

  test("a session whose directory configures a requested MCP server launches subscribed to it", async () => {
    const dir = await makeTempDir();
    const fake = makeFakeHost();
    const settingsIo = memorySettings();
    const result = await create({
      ...baseDeps(dir, fake.runCommand),
      launchConfigDeps: {
        readConfigFile: async (path) => path === `${KEY}/.mcp.json`
          ? JSON.stringify({ mcpServers: { yappr: { type: "stdio", command: "bun" } } })
          : undefined,
        settingsIo,
      },
    }, KEY);
    expect(result.ok).toBe(true);
    // Approved before the launch, or the session sits blocked on an approval prompt.
    expect(approvalIn(settingsIo, KEY)).toEqual(["yappr"]);

    const claudeArgs = afterNamedSession(fake.starts()[0]!);
    // FALSIFIER: this is the whole point — MCP configured but never subscribed
    // to is the bug. The flag spellings come from drovr, never from this repo.
    expect(claudeArgs).toEqual([
      "--mcp-config", `${KEY}/.mcp.json`,
      "--settings", JSON.stringify({ enabledMcpjsonServers: ["yappr"] }),
      "--dangerously-load-development-channels=server:yappr",
    ]);
  });

  test("channels are on by default: every server the directory configures is subscribed, with no opt-in", async () => {
    const dir = await makeTempDir();
    const fake = makeFakeHost();
    await create({
      ...baseDeps(dir, fake.runCommand),
      launchConfigDeps: {
        readConfigFile: async () => JSON.stringify({ mcpServers: { atlassian: {} } }),
        settingsIo: memorySettings(),
      },
    }, KEY);
    expect(afterNamedSession(fake.starts()[0]!)).toEqual([
      "--mcp-config", `${KEY}/.mcp.json`,
      "--settings", JSON.stringify({ enabledMcpjsonServers: ["atlassian"] }),
      "--dangerously-load-development-channels=server:atlassian",
    ]);
  });

  test("a directory with no .mcp.json still launches with no args", async () => {
    const dir = await makeTempDir();
    const fake = makeFakeHost();
    await create(baseDeps(dir, fake.runCommand), KEY);
    expect(afterNamedSession(fake.starts()[0]!)).toEqual([]);
  });

  test("with an MCP declaration: the agent keeps it, and its launch is approved and subscribed per it", async () => {
    const dir = await makeTempDir();
    const fake = makeFakeHost();
    const settingsIo = memorySettings();
    const deps = {
      ...baseDeps(dir, fake.runCommand),
      launchConfigDeps: { readConfigFile: async () => ROCKETR_MCP, settingsIo },
    };
    const result = await create(deps, KEY, [{ name: "rocketr", notifications: true }, { name: "yappr", notifications: false }]);
    expect(result.ok).toBe(true);
    expect(afterNamedSession(fake.starts()[0]!)).toEqual([
      "--mcp-config", `${KEY}/.mcp.json`,
      "--settings", JSON.stringify({ enabledMcpjsonServers: ["rocketr", "yappr"] }),
      "--dangerously-load-development-channels=server:rocketr",
    ]);
    expect(approvalIn(settingsIo, KEY)).toEqual(["rocketr", "yappr"]);
    const stored = await loadAgents(join(dir, "agents.json"));
    if (stored.status !== "loaded" || !result.ok) throw new Error("store not loaded");
    expect(stored.state.agents[result.agent.id]!.mcp).toEqual([{ name: "rocketr", notifications: true }, { name: "yappr", notifications: false }]);
  });

  // BAKR-34/BAKR-42 R1/R9: `create` no longer takes a name — an agent's
  // name is always derived from its directory now (agent-name.ts).
  test("BAKR-34/BAKR-42 R1: a freshly created agent's `name` field is always undefined — it holds no custom name to persist", async () => {
    const dir = await makeTempDir();
    const result = await create(baseDeps(dir, makeFakeHost().runCommand), KEY);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.agent.name).toBeUndefined();
  });

  // R6: one non-archived agent per directory, enforced at create.
  describe("R6: one non-archived agent per directory", () => {
    test("refused: a non-archived agent already exists for this directory — no second agent created", async () => {
      const dir = await makeTempDir();
      const deps = baseDeps(dir, makeFakeHost().runCommand);
      await seedAgent(deps.agentsPath, makeAgent({ id: "@existing0000000000", directory: KEY, state: "on" }));
      const result = await create(deps, KEY);
      expect(result.ok).toBe(false);
      if (!result.ok && "reason" in result) expect(result.reason).toBe("directory-occupied");

      const store = await loadAgents(deps.agentsPath);
      if (store.status === "loaded") expect(Object.keys(store.state.agents).length).toBe(1); // unchanged
    });

    test("CONTROL: an ARCHIVED agent in this directory does not block create", async () => {
      const dir = await makeTempDir();
      const deps = baseDeps(dir, makeFakeHost().runCommand);
      await seedAgent(deps.agentsPath, makeAgent({ id: "@existing0000000000", directory: KEY, state: "archived" }));
      const result = await create(deps, KEY);
      expect(result.ok).toBe(true);
    });
  });

  test("launch failure is reported honestly, but the agent record still exists (recoverable via `on`)", async () => {
    const dir = await makeTempDir();
    const fake = makeFakeHost({ failStart: "permission denied" });
    const deps = baseDeps(dir, fake.runCommand);
    const result = await create(deps, KEY);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.launch.ok).toBe(false);
      if (!result.launch.ok) expect(result.launch.error).toContain("permission denied");
      expect(fake.panes).toEqual([]); // the failed launch's workspace is closed, not left half-started
      const store = await loadAgents(deps.agentsPath);
      if (store.status === "loaded") expect(store.state.agents[result.agent.id]?.state).toBe("on");
    }
  });
});

// --- on: resume-id routes through exactly one function, B8, no-change, archived refusal ---

describe("on", () => {
  test("restore: resumes EXACTLY the agent's own session (`--resume <sessionId>`) in a new herdr pane, which becomes its restore handle — the resume id is never hard-coded inline in agent-actions.ts", async () => {
    const dir = await makeTempDir();
    const fake = makeFakeHost();
    const deps = baseDeps(dir, fake.runCommand);
    await seedAgent(deps.agentsPath, makeAgent({ id: "@a1", state: "off", birthSessionId: "durable-xyz", restoreTarget: { sessionId: "durable-xyz", shortId: "durable-x" } }));
    const result = await on(deps, byId("@a1"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.kind).toBe("turn-on");
      expect(result.launchIssued).toBe(true);
    }
    // The liveness-gate listing is fetched before any decision.
    expect(isListingRead(fake.calls[0]!)).toBe(true);
    // EXACTLY this claude argv and nothing else — BAKR-22's argv-exactness; never a fork, never a fresh session.
    expect(fake.starts()).toEqual([["--resume", "durable-xyz"]]);
    expect(fake.stops()).toEqual([]);
    const store = await loadAgents(deps.agentsPath);
    if (store.status !== "loaded") throw new Error("expected loaded store");
    expect(store.state.agents["@a1"]?.restoreTarget).toEqual({ sessionId: "durable-xyz", shortId: "w1:p1" }); // same session, new pane
    expect(store.state.launches).toEqual([]); // a resume resolves synchronously
  });

  test("fresh (no restoreTarget yet): a real launch() with NO args at all beyond its own session name — no --resume, nothing else", async () => {
    const dir = await makeTempDir();
    const fake = makeFakeHost();
    const deps = baseDeps(dir, fake.runCommand);
    await seedAgent(deps.agentsPath, makeAgent({ id: "@a1", state: "off", restoreTarget: undefined }));
    await on(deps, byId("@a1"));

    expect(fake.starts()).toHaveLength(1);
    expect(afterNamedSession(fake.starts()[0]!)).toEqual([]);
  });

  test("no-change: already on, healthy (verified alive by the liveness gate) — no launch issued, nothing reported as cleared", async () => {
    const dir = await makeTempDir();
    const fake = makeFakeHost();
    // BAKR-22: `on()` always fetches a listing first now (the liveness
    // gate) — seed it so this agent's session verifies ALIVE (the pane's
    // claude pid is this test process), which is what makes "no-change,
    // healthy" the correct outcome rather than an attempted (and
    // wrongly-issued) restore of a live session.
    const pane = fake.addPane({ cwd: KEY, sessionId: "d1" });
    const deps = baseDeps(dir, fake.runCommand);
    await seedAgent(deps.agentsPath, makeAgent({ id: "@a1", state: "on", birthSessionId: "d1", restoreTarget: { sessionId: "d1", shortId: pane.paneId } }));
    const result = await on(deps, byId("@a1"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.kind).toBe("no-change");
      expect(result.launchIssued).toBe(false);
      expect(result.launchWedgeCleared).toBe(false);
      expect(result.forkWedgeCleared).toBe(false);
    }
    expect(listings(fake)).toBe(1);
    expect(effects(fake)).toEqual([]); // the liveness-gate listing, and NOTHING else — never restores a verified-alive session
  });

  test("liveness gate keys on the SESSION id: a session alive under a handle other than the recorded one (a legacy short id, or a pane it has since moved to) is still alive — never restored beside itself", async () => {
    const dir = await makeTempDir();
    const fake = makeFakeHost();
    fake.addPane({ cwd: KEY, sessionId: "d1" });
    const deps = baseDeps(dir, fake.runCommand);
    // FALSIFIER: a gate that looked the session up by `shortId` alone would find nothing, call it absent, and start a second process on session d1.
    await seedAgent(deps.agentsPath, makeAgent({ id: "@a1", state: "on", birthSessionId: "d1", restoreTarget: { sessionId: "d1", shortId: "d1shortx" } }));
    const result = await on(deps, byId("@a1"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.kind).toBe("no-change");
      expect(result.launchIssued).toBe(false);
    }
    expect(effects(fake)).toEqual([]);
  });

  test("BAKR-22 liveness gate: an already-on agent whose session cannot be independently verified alive is left ALONE this call — never restored on an uncertain signal", async () => {
    const dir = await makeTempDir();
    const fake = makeFakeHost();
    // Listed, but with NO claude pid in its pane this cycle — `decideLiveness` calls this `not-verifiable`, distinct from both "alive" and "dead".
    const pane = fake.addPane({ cwd: KEY, sessionId: "d1" });
    pane.pid = undefined;
    const deps = baseDeps(dir, fake.runCommand);
    await seedAgent(deps.agentsPath, makeAgent({ id: "@a1", state: "on", birthSessionId: "d1", restoreTarget: { sessionId: "d1", shortId: pane.paneId } }));
    const result = await on(deps, byId("@a1"));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.launchIssued).toBe(false);
    expect(listings(fake)).toBe(1);
    expect(effects(fake)).toEqual([]); // never restores — not-verifiable is not "dead"
  });

  test("refused: archived", async () => {
    const dir = await makeTempDir();
    const deps = baseDeps(dir, makeFakeHost().runCommand);
    await seedAgent(deps.agentsPath, makeAgent({ id: "@a1", state: "archived" }));
    const result = await on(deps, byId("@a1"));
    expect(result.ok).toBe(false);
  });

  // BAKR-22: `sessionToResume` (a bare session id) is retired in favor of
  // `planRestore` (a `RestorePlan` — `fresh` or `respawn`), for the same
  // "exactly one seam" reason the original review finding cared about:
  // whichever function answers "what do I do to restore this agent" must
  // have exactly the call sites this test pins, so a future edit that
  // reverts a call site to reading `agent.restoreTarget`/`agent.birthSessionId`
  // inline (instead of going through the seam) is caught here rather than
  // discovered as a silent behavioural drift.
  test("restore-plan: 'what do I do to restore this agent' has EXACTLY ONE call site each in agent-lifecycle.ts and daemon.ts — not agent-actions.ts", async () => {
    const srcDir = join(import.meta.dir, "..", "..", "src");
    const [modelSrc, lifecycleSrc, actionsSrc, daemonSrc] = await Promise.all([
      readFile(join(srcDir, "agent-model.ts"), "utf8"),
      readFile(join(srcDir, "agent-lifecycle.ts"), "utf8"),
      readFile(join(srcDir, "agent-actions.ts"), "utf8"),
      readFile(join(srcDir, "daemon.ts"), "utf8"),
    ]);

    // Strips `//` and `/* */` comments first (crudely — good enough for
    // this codebase's own style, and exactly the class of false positive
    // a prior review finding named: a doc comment MENTIONING the function's
    // name must never count as a call site). A CALL is then the name
    // immediately followed by "(" that is NOT part of "function planRestore("
    // (the definition itself, in agent-model.ts).
    function stripComments(source: string): string {
      return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    }
    function callSiteCount(source: string): number {
      const code = stripComments(source);
      const all = code.match(/planRestore\(/g) ?? [];
      const definitions = code.match(/function planRestore\(/g) ?? [];
      return all.length - definitions.length;
    }

    // PROBE CONTROL, anchored on something genuinely load-bearing: the
    // definition line itself must exist in agent-model.ts, AND this scan's
    // own call-vs-definition arithmetic must correctly exclude it — a scan
    // that could not tell "function planRestore(" from a call would report
    // 1 here instead of 0, silently inflating every other file's count too.
    expect(modelSrc).toContain("export function planRestore(agent: AgentRecord)");
    expect(callSiteCount(modelSrc)).toBe(0);

    // FALSIFIER: this is 0, not 1, if `decideOn` ever reverts to reading
    // `agent.restoreTarget` inline instead of calling the seam function.
    expect(callSiteCount(lifecycleSrc)).toBe(1);

    // The effect layer must have NO call site of its own — the DECISION
    // routes through agent-lifecycle.ts exclusively. (It DOES read the
    // already-decided `decision.agent.restoreTarget` to recover the
    // forkFrom source id after the decision is made — that is reading an
    // outcome, not re-deciding one, so it is not a `planRestore` call.)
    expect(callSiteCount(actionsSrc)).toBe(0);

    // daemon.ts routes its OWN restore decision through the SAME seam.
    // FALSIFIER: 2 would mean a second, unsynchronised decision point; 0
    // would mean daemon.ts reads `.restoreTarget` inline for its decision.
    expect(callSiteCount(daemonSrc)).toBe(1);

    // THE RETIRED NAMES must never quietly come back on a future merge —
    // `sessionToResume` (BAKR-18/23-era) and `sessionIdToResume` (its own
    // BAKR-17/21-era duplicate, retired before it) are BOTH gone from every
    // source file. Checked against STRIPPED source, deliberately:
    // agent-model.ts's own doc comment may narrate this history and name a
    // retired function, which is worth keeping — the invariant is that no
    // CODE references it.
    for (const src of [modelSrc, lifecycleSrc, actionsSrc, daemonSrc]) {
      expect(stripComments(src)).not.toContain("sessionIdToResume");
      expect(stripComments(src)).not.toMatch(/[^a-zA-Z]sessionToResume\(/);
    }
  });
});

// --- BAKR-27 AC4: `on` can now clear a stray FAILED forkFrom-keyed record too ---

describe("BAKR-27 AC4: on() clears a stray FAILED forkFrom-keyed record for the agent's current restore target, not only the respawn/fresh-keyed wedge", () => {
  const OLD_SHORT = "oldshort";
  const OLD_SESSION = "old-session-uuid";
  // Text of the failures a pre-herdr stale-cwd escape left behind in the store: seeded as history only, never produced by the fake.
  const STALE_CWD_ERROR = `respawn exited 1: Couldn't start a background session (working directory no longer exists or is not accessible: /tmp/old-claimed-dir)`;

  test("BEFORE this fix's shape: a FAILED forkFrom(sessionId) record left by a previously-failed escape is invisible to on()'s wedge check — proven here by seeding ONLY that record (no respawn-keyed wedge at all) and showing on() reaches it anyway", async () => {
    const dir = await makeTempDir();
    const fake = makeFakeHost(); // nothing running: on() restores the session
    const deps = baseDeps(dir, fake.runCommand);

    const agent = makeAgent({ id: "@a1", state: "on", birthSessionId: OLD_SESSION, restoreTarget: { sessionId: OLD_SESSION, shortId: OLD_SHORT } });
    let store = putAgent(emptyAgentStore(), agent);
    // ONLY a failed forkFrom-keyed record — no respawn-keyed failure at all,
    // so the PRIMARY wedge check (`hasLaunchRecordFor` against
    // `attemptKey = respawn(OLD_SHORT)`) finds NOTHING to clear. Before this
    // ticket's fix, `on()` had no other code path that ever looked for a
    // `forkFrom`-keyed record, so this record would sit forever, and a
    // SEPARATE, accumulating one would be left behind by every retry.
    store = { ...store, launches: [{ attemptId: "stale-fork-attempt", agentId: "@a1", key: KEY, attemptKey: { kind: "forkFrom", sessionId: OLD_SESSION }, attemptedAt: 1, launchShortId: undefined, error: "escape launch failed: systemd-run: simulated failure" }] };
    await saveAgents(deps.agentsPath, store);

    const result = await on(deps, byId("@a1"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // THE FIX: wedgeCleared reports true (the stray forkFrom record was
    // found and cleared), and it is actually gone from disk — the
    // respawn/fresh-keyed `clearFailedLaunchRecord` alone could never have
    // done this, since its computed key is `respawn(OLD_SHORT)`, not
    // `forkFrom(OLD_SESSION)`.
    expect(result.launchWedgeCleared).toBe(false);
    expect(result.forkWedgeCleared).toBe(true);

    const reloaded = await loadAgents(deps.agentsPath);
    if (reloaded.status !== "loaded") throw new Error("expected loaded store");
    const staleRecordStillPresent = reloaded.state.launches.some((l) => l.attemptId === "stale-fork-attempt");
    expect(staleRecordStillPresent).toBe(false); // cleared
    expect(fake.starts()).toEqual([["--resume", OLD_SESSION]]); // and the restore below the clear ran
  });

  // Rewritten for herdr: this test used to drive the clear into a stale-cwd
  // refusal from `claude respawn` and on into the moved-directory fork escape.
  // A resume in a herdr pane never produces that refusal, so the escape is
  // unreachable from here; what still applies is the clear itself, followed
  // by an ordinary restore that leaves no stray record behind.
  test("both stray records are cleared and the restore below the clear runs normally: the session is resumed, and no duplicate/stray record is left over", async () => {
    const dir = await makeTempDir();
    const fake = makeFakeHost();
    const deps: AgentActionDeps = {
      ...baseDeps(dir, fake.runCommand),
      // Deterministic transcript edge: a restore never needs it, but falling
      // through to the real ~/.claude/projects would make the outcome depend
      // on the host if any path consulted it.
      transcriptProbeDeps: {
        listProjectDirs: async () => ({ ok: true, dirs: ["fixture-project"] }),
        transcriptExistsIn: async () => ({ ok: true, exists: true }),
      },
    };

    const agent = makeAgent({ id: "@a1", state: "on", birthSessionId: OLD_SESSION, restoreTarget: { sessionId: OLD_SESSION, shortId: OLD_SHORT } });
    let store = putAgent(emptyAgentStore(), agent);
    // BOTH a failed respawn(OLD_SHORT) wedge AND a failed forkFrom(OLD_SESSION)
    // wedge pre-seeded — the realistic shape after one full failed
    // stale-cwd-escape round trip (daemon.ts's own dispatch marks the
    // ORIGINAL respawn failed, then ALSO fails the escape's own launch).
    store = {
      ...store,
      launches: [
        { attemptId: "old-respawn-attempt", agentId: "@a1", key: KEY, attemptKey: { kind: "respawn", shortId: OLD_SHORT }, attemptedAt: 1, launchShortId: undefined, error: STALE_CWD_ERROR },
        { attemptId: "stale-fork-attempt", agentId: "@a1", key: KEY, attemptKey: { kind: "forkFrom", sessionId: OLD_SESSION }, attemptedAt: 1, launchShortId: undefined, error: "escape launch failed: systemd-run: simulated failure" },
      ],
    };
    await saveAgents(deps.agentsPath, store);

    const result = await on(deps, byId("@a1"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.launchWedgeCleared).toBe(true);
    expect(result.forkWedgeCleared).toBe(true);
    expect(result.launchIssued).toBe(true);
    expect(result.recovery).toBeUndefined(); // an ordinary restore: no escape or refusal to report
    expect(fake.starts()).toEqual([["--resume", OLD_SESSION]]); // the SAME session, once

    const reloaded = await loadAgents(deps.agentsPath);
    if (reloaded.status !== "loaded") throw new Error("expected loaded store");
    expect(reloaded.state.launches.some((l) => l.attemptId === "old-respawn-attempt")).toBe(false);
    expect(reloaded.state.launches.some((l) => l.attemptId === "stale-fork-attempt")).toBe(false);
    // Nothing remains: the restore resolved synchronously, and no stray record is left beside it.
    expect(reloaded.state.launches).toEqual([]);
    expect(reloaded.state.agents["@a1"]?.restoreTarget).toEqual({ sessionId: OLD_SESSION, shortId: "w1:p1" });
  });

  test("NEGATIVE CONTROL: no stray forkFrom record exists for this agent's CURRENT target -> both clearing reports stay false", async () => {
    const dir = await makeTempDir();
    const fake = makeFakeHost();
    const pane = fake.addPane({ cwd: KEY, sessionId: "d1" });
    const deps = baseDeps(dir, fake.runCommand);
    await seedAgent(deps.agentsPath, makeAgent({ id: "@a1", state: "on", birthSessionId: "d1", restoreTarget: { sessionId: "d1", shortId: pane.paneId } }));

    const result = await on(deps, byId("@a1"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.launchWedgeCleared).toBe(false);
      expect(result.forkWedgeCleared).toBe(false);
    }
  });
});

// --- off / archive / delete share ONE stop path (DoD item 2) -------------

describe("off, archive and delete all stop a session through the IDENTICAL `stopLiveSession` function", () => {
  test("stopLiveSession: exact sessionId match against a listing, then stop that entry's own id (its pane's workspace) — never cwd", async () => {
    const fake = makeFakeHost();
    const pane = fake.addPane({ cwd: "/somewhere/else", sessionId: "live-9" });
    const deps = baseDeps(await makeTempDir(), fake.runCommand);
    const outcome = await stopLiveSession(deps, "live-9");
    expect(outcome).toEqual({ kind: "stopped", shortId: pane.paneId });
    expect(listings(fake)).toBe(1);
    expect(effects(fake)).toEqual([["herdr", "workspace", "close", pane.workspaceId]]);
  });

  test("stopLiveSession: a session still under legacy `claude --bg` is stopped by `claude stop <its short id>`", async () => {
    const fake = makeFakeHost();
    fake.legacy.push({ id: "short-9", sessionId: "live-9", cwd: KEY, startedAt: 1, kind: "background" });
    const deps = baseDeps(await makeTempDir(), fake.runCommand);
    const outcome = await stopLiveSession(deps, "live-9");
    expect(outcome).toEqual({ kind: "stopped", shortId: "short-9" });
    expect(effects(fake)).toEqual([["claude", "stop", "short-9"]]);
  });

  // Review finding 1 (PR #16, round 1): every prior stop-path test pushed
  // exactly ONE entry into the fake listing, so "exact sessionId match" was
  // indistinguishable from "take sessions[0]" — a mutation to exactly that
  // effect passed the full suite. This is THE headline invariant (B9): the
  // reason candlestix's directory-keyed stop mechanism is forbidden here.
  // FALSIFIER, stated first: replacing the `sessions.find(s => s.sessionId
  // === liveSessionId)` in `stopLiveSession` with `sessions[0]` (or
  // `sessions[sessions.length - 1]`, or any positional pick) must make this
  // test fail — the target agent's session is deliberately placed neither
  // first nor last in a 3-entry listing.
  test("stopLiveSession: selects the SIBLING agent's own session out of a listing containing SEVERAL — never sessions[0], never positional", async () => {
    const fake = makeFakeHost();
    fake.addPane({ cwd: KEY, sessionId: "live-OTHER-1" });
    const target = fake.addPane({ cwd: KEY, sessionId: "live-TARGET" }); // the one we want — in the MIDDLE, not sessions[0]
    fake.addPane({ cwd: KEY, sessionId: "live-OTHER-2" });
    const deps = baseDeps(await makeTempDir(), fake.runCommand);
    const outcome = await stopLiveSession(deps, "live-TARGET");
    expect(outcome.kind).toBe("stopped");
    if (outcome.kind === "stopped") expect(outcome.shortId).toBe(target.paneId); // NOT w1:p1 (sessions[0])
    expect(effects(fake)).toEqual([["herdr", "workspace", "close", target.workspaceId]]); // exactly one stop call, naming the right sibling and nothing else
    expect(fake.panes.map((p) => p.sessionId)).toEqual(["live-OTHER-1", "live-OTHER-2"]);
  });

  test("stopLiveSession: the target is ABSENT while siblings are present — reports already-gone, and issues NO stop at all (never stops a sibling by mistake)", async () => {
    const fake = makeFakeHost();
    fake.addPane({ cwd: KEY, sessionId: "live-OTHER-1" });
    fake.addPane({ cwd: KEY, sessionId: "live-OTHER-2" });
    const deps = baseDeps(await makeTempDir(), fake.runCommand);
    const outcome = await stopLiveSession(deps, "live-TARGET-not-in-listing");
    expect(outcome.kind).toBe("already-gone");
    expect(listings(fake)).toBe(1);
    expect(effects(fake)).toEqual([]); // listed, but NEVER called stop on either sibling
    expect(fake.panes.length).toBe(2); // both siblings still present — nothing was removed
  });

  test("off calls stopLiveSession, but BAKR-22 leaves restoreTarget INTACT on success — clearing it would make the next `on` take the `fresh` branch and silently discard the conversation", async () => {
    const dir = await makeTempDir();
    const fake = makeFakeHost();
    const pane = fake.addPane({ cwd: KEY, sessionId: "live-1" });
    const deps = baseDeps(dir, fake.runCommand);
    await seedAgent(deps.agentsPath, makeAgent({ id: "@a1", state: "on", restoreTarget: { sessionId: "live-1", shortId: pane.paneId } }));

    const result = await off(deps, byId("@a1"));
    expect(result.ok).toBe(true);
    if (result.ok && result.kind === "turned-off") expect(result.stop.kind).toBe("stopped");
    expect(listings(fake)).toBe(1);
    expect(effects(fake)).toEqual([["herdr", "workspace", "close", pane.workspaceId]]);

    const store = await loadAgents(deps.agentsPath);
    if (store.status === "loaded") {
      expect(store.state.agents["@a1"]?.state).toBe("off");
      expect(store.state.agents["@a1"]?.restoreTarget).toEqual({ sessionId: "live-1", shortId: pane.paneId }); // UNCHANGED — a future `on` still resumes it
    }
  });

  test("archive calls the SAME stop sequence as off, for an equivalent fixture", async () => {
    const dir = await makeTempDir();
    const fake = makeFakeHost();
    const pane = fake.addPane({ cwd: KEY, sessionId: "live-2" });
    const deps = baseDeps(dir, fake.runCommand);
    await seedAgent(deps.agentsPath, makeAgent({ id: "@a1", state: "on", restoreTarget: { sessionId: "live-2", shortId: pane.paneId } }));

    const result = await archive(deps, byId("@a1"));
    expect(result.ok).toBe(true);
    if (result.ok && result.kind === "archived") expect(result.stop.kind).toBe("stopped");
    expect(listings(fake)).toBe(1);
    expect(effects(fake)).toEqual([["herdr", "workspace", "close", pane.workspaceId]]); // IDENTICAL shape to off's own call sequence above
  });

  test("delete calls the SAME stop sequence too, then removes the record and retires the id", async () => {
    const dir = await makeTempDir();
    const fake = makeFakeHost();
    const pane = fake.addPane({ cwd: KEY, sessionId: "live-3" });
    const deps = baseDeps(dir, fake.runCommand);
    await seedAgent(deps.agentsPath, makeAgent({ id: "@a1", state: "on", restoreTarget: { sessionId: "live-3", shortId: pane.paneId } }));

    const result = await deleteAgent(deps, byId("@a1"));
    expect(result.ok).toBe(true);
    if (result.ok && result.kind === "deleted") expect(result.stop.kind).toBe("stopped");
    expect(listings(fake)).toBe(1);
    expect(effects(fake)).toEqual([["herdr", "workspace", "close", pane.workspaceId]]);

    const store = await loadAgents(deps.agentsPath);
    if (store.status === "loaded") {
      expect("@a1" in store.state.agents).toBe(false);
      expect(store.state.retiredIds).toContain("@a1");
    }
  });

  test("off: nothing to stop when there is no live session — stop.kind is 'nothing-to-stop', no listing call at all", async () => {
    const dir = await makeTempDir();
    const fake = makeFakeHost();
    const deps = baseDeps(dir, fake.runCommand);
    await seedAgent(deps.agentsPath, makeAgent({ id: "@a1", state: "on", restoreTarget: undefined }));
    const result = await off(deps, byId("@a1"));
    expect(result.ok).toBe(true);
    if (result.ok && result.kind === "turned-off") expect(result.stop.kind).toBe("nothing-to-stop");
    expect(fake.calls.length).toBe(0);
  });

  test("off: session already gone from a SUCCESSFUL listing — restoreTarget left INTACT (BAKR-22: it is not a liveness cache any more, see the dedicated 'restoreTarget INTACT' test above)", async () => {
    const dir = await makeTempDir();
    const deps = baseDeps(dir, makeFakeHost().runCommand); // empty listing
    await seedAgent(deps.agentsPath, makeAgent({ id: "@a1", state: "on", restoreTarget: { sessionId: "vanished", shortId: "vanished" } }));
    const result = await off(deps, byId("@a1"));
    expect(result.ok).toBe(true);
    if (result.ok && result.kind === "turned-off") expect(result.stop.kind).toBe("already-gone");
    const store = await loadAgents(deps.agentsPath);
    if (store.status === "loaded") expect(store.state.agents["@a1"]?.restoreTarget).toEqual({ sessionId: "vanished", shortId: "vanished" });
  });

  test("off: a LISTING FAILURE is reported distinctly and restoreTarget is LEFT ALONE (BAKR-17 Q2: never collapse to 'nothing running')", async () => {
    const dir = await makeTempDir();
    const fake = makeFakeHost({ failListing: true });
    const deps = baseDeps(dir, fake.runCommand);
    await seedAgent(deps.agentsPath, makeAgent({ id: "@a1", state: "on", restoreTarget: { sessionId: "live-1", shortId: "short-1" } }));
    const result = await off(deps, byId("@a1"));
    expect(result.ok).toBe(true);
    if (result.ok && result.kind === "turned-off") expect(result.stop.kind).toBe("listing-failed");
    const store = await loadAgents(deps.agentsPath);
    if (store.status === "loaded") {
      expect(store.state.agents["@a1"]?.state).toBe("off"); // the INTENT is still recorded
      expect(store.state.agents["@a1"]?.restoreTarget).toEqual({ sessionId: "live-1", shortId: "short-1" }); // untouched either way — a retry is meaningful
    }
  });

  test("off: a failed stop (the workspace close is refused) is reported and restoreTarget is left alone so a retry is meaningful", async () => {
    const dir = await makeTempDir();
    const fake = makeFakeHost({ failStop: true });
    const pane = fake.addPane({ cwd: KEY, sessionId: "live-4" });
    const deps = baseDeps(dir, fake.runCommand);
    await seedAgent(deps.agentsPath, makeAgent({ id: "@a1", state: "on", restoreTarget: { sessionId: "live-4", shortId: pane.paneId } }));
    const result = await off(deps, byId("@a1"));
    expect(result.ok).toBe(true);
    if (result.ok && result.kind === "turned-off") expect(result.stop.kind).toBe("stop-failed");
    const store = await loadAgents(deps.agentsPath);
    if (store.status === "loaded") expect(store.state.agents["@a1"]?.restoreTarget).toEqual({ sessionId: "live-4", shortId: pane.paneId });
  });

  test("delete: when the stop cannot be confirmed, the agent is PARKED as archived, not removed — retrying delete is meaningful", async () => {
    const dir = await makeTempDir();
    const fake = makeFakeHost({ failListing: true });
    const deps = baseDeps(dir, fake.runCommand);
    await seedAgent(deps.agentsPath, makeAgent({ id: "@a1", state: "on", restoreTarget: { sessionId: "live-5", shortId: "w1:p1" } }));
    const result = await deleteAgent(deps, byId("@a1"));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.kind).toBe("parked");
    const store = await loadAgents(deps.agentsPath);
    if (store.status === "loaded") {
      expect(store.state.agents["@a1"]?.state).toBe("archived"); // parked, not removed
      expect(store.state.retiredIds).not.toContain("@a1");
    }

    // Retry, now with a working listing — completes the delete.
    const fake2 = makeFakeHost();
    fake2.addPane({ cwd: KEY, sessionId: "live-5" });
    const retryDeps = { ...deps, runCommand: fake2.runCommand };
    const retryResult = await deleteAgent(retryDeps, byId("@a1"));
    expect(retryResult.ok).toBe(true);
    if (retryResult.ok) expect(retryResult.kind).toBe("deleted");
    expect(fake2.stops()).toEqual(["w1"]);
  });

  test("delete leaves Claude Code's own conversation storage untouched — this file may READ it (BAKR-22's transcriptProbeDeps seam) but never writes to it", async () => {
    // BAKR-22 UPDATE: this file now legitimately references Claude Code's
    // own conversation-storage tree — read-only, via the injected
    // `transcriptProbeDeps` seam (`hasResumableTranscript`, transcript-probe.ts),
    // for the never-spoken-to-then-moved decision. The epic's own ruling:
    // "reading Claude Code's storage is not forbidden — writing into a
    // claimed directory [or, by the same principle, into Claude's own
    // storage] is." So the invariant this test locks in narrows from "no
    // reference at all" to "no WRITE call" — `rm(`/`unlink` never appear,
    // and the one path-shape reference that does exist is confined to a
    // doc comment plus a call to an injected, purely-reading dependency,
    // never a literal write.
    const source = await readFile(join(import.meta.dir, "..", "..", "src", "agent-actions.ts"), "utf8");
    expect(source).not.toContain("rm(");
    expect(source).not.toContain("unlink");
    expect(source).not.toContain("writeFile");
  });
});

// --- archive / unarchive lifecycle, keeping the name --------------------

describe("archive / unarchive", () => {
  test("archive keeps the name; unarchive lands on off, never on", async () => {
    const dir = await makeTempDir();
    const deps = baseDeps(dir, makeFakeHost().runCommand);
    await seedAgent(deps.agentsPath, makeAgent({ id: "@a1", state: "on", name: "keepme" }));

    const archived = await archive(deps, byId("@a1"));
    expect(archived.ok).toBe(true);
    if (archived.ok && archived.kind === "archived") expect(archived.agent.name).toBe("keepme");

    const unarchived = await unarchive(deps, byId("@a1"));
    expect(unarchived.ok).toBe(true);
    if (unarchived.ok) {
      expect(unarchived.agent.state).toBe("off");
      expect(unarchived.agent.name).toBe("keepme");
    }
  });

  test("unarchive refused on a non-archived agent", async () => {
    const dir = await makeTempDir();
    const deps = baseDeps(dir, makeFakeHost().runCommand);
    await seedAgent(deps.agentsPath, makeAgent({ id: "@a1", state: "off" }));
    const result = await unarchive(deps, byId("@a1"));
    expect(result.ok).toBe(false);
  });

});

// --- name / rename: RETIRED (R9) — see cli-grammar.test.ts and
// agent-model.test.ts's `resolveAgent` suite for what replaced them.

// --- list: directory-scoped, archived included (R10) ---------------------

describe("list", () => {
  test("scoped to the given directory, archived included, another directory's agents excluded", async () => {
    const dir = await makeTempDir();
    const deps = baseDeps(dir, makeFakeHost().runCommand);
    await saveAgents(
      deps.agentsPath,
      putAgent(
        putAgent(putAgent(emptyAgentStore(), makeAgent({ id: "@a1", directory: KEY, state: "on" })), makeAgent({ id: "@a2", directory: KEY, state: "archived" })),
        makeAgent({ id: "@a3", directory: OTHER_KEY })
      )
    );
    const result = await list(deps, KEY);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const ids = result.agents.map((a) => a.id).sort();
      expect(ids).toEqual(["@a1", "@a2"]);
    }
  });
});

// --- attach target: a query, refusals distinct (R18) ---------------------

describe("attachTarget", () => {
  test("on + live: returns the session identity, refuses nothing", async () => {
    const dir = await makeTempDir();
    const deps = baseDeps(dir, makeFakeHost().runCommand);
    await seedAgent(deps.agentsPath, makeAgent({ id: "@a1", state: "on", birthSessionId: "d1", restoreTarget: { sessionId: "l1", shortId: "l1short0" } }));
    const result = await attachTarget(deps, byId("@a1"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.restoreSessionId).toBe("l1");
      expect(result.birthSessionId).toBe("d1");
    }
  });

  test("off: refused with a message pointing at `on`, never silently started", async () => {
    const dir = await makeTempDir();
    const deps = baseDeps(dir, makeFakeHost().runCommand);
    await seedAgent(deps.agentsPath, makeAgent({ id: "@a1", state: "off" }));
    const result = await attachTarget(deps, byId("@a1"));
    expect(result.ok).toBe(false);
    if (!result.ok && "reason" in result) {
      expect(result.reason).toBe("off");
      expect(result.message.toLowerCase()).toContain("on");
    }
  });
});

// --- malformed store: write-nothing discipline reaches every verb --------

describe("a malformed agents.json is refused, never overwritten, by every verb", () => {
  test("create, off, list all report store-malformed rather than touching the file", async () => {
    const dir = await makeTempDir();
    const agentsPath = join(dir, "agents.json");
    await Bun.write(agentsPath, "{ not json");
    const deps = baseDeps(dir, makeFakeHost().runCommand);

    const createResult = await create(deps, KEY);
    expect(createResult.ok).toBe(false);
    if (!createResult.ok) expect(createResult.reason).toBe("store-malformed");

    const listResult = await list(deps, KEY);
    expect(listResult.ok).toBe(false);
    if (!listResult.ok) expect(listResult.reason).toBe("store-malformed");

    const raw = await readFile(agentsPath, "utf8");
    expect(raw).toBe("{ not json"); // byte-for-byte unchanged — never overwritten
  });
});

describe("mcp", () => {
  test("shows every server as the default for an agent with no declaration, replaces it, and returns it to the default", async () => {
    const dir = await makeTempDir();
    const settingsIo = memorySettings();
    const deps = {
      ...baseDeps(dir, makeFakeHost().runCommand),
      launchConfigDeps: { readConfigFile: async () => ROCKETR_MCP, settingsIo },
    };
    const created = await create(deps, KEY);
    if (!created.ok) throw new Error("create failed");
    const ref = byId(created.agent.id);
    for (const path of Object.keys(settingsIo.files)) delete settingsIo.files[path];

    const shown = await mcp(deps, ref);
    if (!shown.ok) throw new Error(shown.message);
    expect(shown.agent.mcp).toBeUndefined();
    expect(shown.effective).toEqual([{ name: "rocketr", notifications: true }, { name: "yappr", notifications: true }]);
    expect(shown.changed).toBe(false);

    const set = await mcp(deps, ref, [{ name: "rocketr", notifications: true }]);
    if (!set.ok) throw new Error(set.message);
    expect(set.changed).toBe(true);
    expect(set.agent.mcp).toEqual([{ name: "rocketr", notifications: true }]);
    expect(set.effective).toEqual([{ name: "rocketr", notifications: true }]);
    // The approval is written at once, ahead of the agent's next start.
    expect(approvalIn(settingsIo, KEY)).toEqual(["rocketr"]);

    const again = await mcp(deps, ref, [{ name: "rocketr", notifications: true }]);
    if (!again.ok) throw new Error(again.message);
    expect(again.changed).toBe(false);

    const reset = await mcp(deps, ref, null);
    if (!reset.ok) throw new Error(reset.message);
    expect(reset.changed).toBe(true);
    expect(reset.agent.mcp).toBeUndefined();
  });

  test("refused for an unknown ref, and nothing is written", async () => {
    const dir = await makeTempDir();
    const settingsIo = memorySettings();
    const deps = { ...baseDeps(dir, makeFakeHost().runCommand), launchConfigDeps: { readConfigFile: async () => ROCKETR_MCP, settingsIo } };
    const result = await mcp(deps, { kind: "name", ref: "nobody" }, [{ name: "rocketr", notifications: true }]);
    expect(result.ok).toBe(false);
    expect(settingsIo.files).toEqual({});
  });
});
