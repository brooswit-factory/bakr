// Integration coverage for agent-actions.ts's effect layer, against a real
// temp-dir store through the real `withAgentStoreLock`, with a fake
// `runCommand` standing in for `claude`/`systemd-run` (no real process
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
  name as nameVerb,
  off,
  on,
  rename,
  stopLiveSession,
  unarchive,
  type AgentActionDeps,
} from "../../src/agent-actions";
import type { ClaimKey } from "../../src/claim-key-resolve";
import type { CommandResult, RunCommandOptions } from "../../src/spawn";

const KEY = "/claimed/dir" as ClaimKey;
const OTHER_KEY = "/claimed/other" as ClaimKey;

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

interface FakeListingEntry {
  id: string;
  sessionId: string;
  cwd: string;
  startedAt: number;
  kind: string;
  pid?: number;
}

/** Records every argv this test's fake `runCommand` sees, in order — the raw evidence a test can assert the exact stop/launch mechanism against. */
function makeFakeClaude(opts?: { failListing?: boolean; stopBehavior?: (id: string) => { ok: boolean; error?: string } }) {
  const listing: FakeListingEntry[] = [];
  const calls: string[][] = [];
  let nextShortId = 0;

  async function runCommand(argv: string[], cmdOpts: RunCommandOptions): Promise<CommandResult> {
    calls.push(argv);
    if (argv[0] === "claude" && argv[1] === "agents") {
      if (opts?.failListing) throw new Error("simulated listing failure");
      return { exitCode: 0, stdout: JSON.stringify(listing), stderr: "" };
    }
    if (argv[0] === "claude" && argv[1] === "stop") {
      const id = argv[2] as string;
      const behavior = opts?.stopBehavior?.(id) ?? { ok: true };
      if (!behavior.ok) return { exitCode: 1, stdout: "", stderr: behavior.error ?? "stop failed" };
      const idx = listing.findIndex((s) => s.id === id);
      if (idx !== -1) listing.splice(idx, 1);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (argv[0] === "systemd-run") {
      const shortId = `short-${nextShortId++}`;
      const sessionId = `session-${shortId}`;
      listing.push({ id: shortId, sessionId, cwd: cmdOpts.cwd ?? "", startedAt: 1, kind: "background", pid: 12345 });
      return { exitCode: 0, stdout: `backgrounded · ${shortId} (idle — send a prompt to start)\n`, stderr: "" };
    }
    throw new Error(`fake runCommand: unexpected argv ${JSON.stringify(argv)}`);
  }

  return { runCommand, listing, calls };
}

function baseDeps(dir: string, runCommand: AgentActionDeps["runCommand"]): AgentActionDeps {
  let counter = 0;
  let randomCounter = 0;
  return {
    agentsPath: join(dir, "agents.json"),
    runCommand,
    now: () => 1_700_000_000_000,
    generateAttemptId: () => `attempt-${counter++}`,
    randomBytes: (n: number) => {
      randomCounter += 1;
      return new Uint8Array(n).fill(randomCounter & 0xff);
    },
  };
}

function makeAgent(overrides: Partial<AgentRecord> & { id: string }): AgentRecord {
  return { name: undefined, directory: KEY, state: "on", createdAt: 1, durableSessionId: undefined, liveSessionId: undefined, ...overrides };
}

async function seedAgent(agentsPath: string, agent: AgentRecord): Promise<void> {
  await saveAgents(agentsPath, putAgent(emptyAgentStore(), agent));
}

// --- create: B8 (no prompt at all), name validation, honest about sessionId ---

describe("create", () => {
  test("mints an unnamed `on` agent and issues a launch with NO ARGS AT ALL (B8: create passes no prompt, no resume)", async () => {
    const dir = await makeTempDir();
    const fake = makeFakeClaude();
    const result = await create(baseDeps(dir, fake.runCommand), KEY);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.agent.state).toBe("on");
    expect(result.agent.name).toBeUndefined();
    expect(result.agent.durableSessionId).toBeUndefined(); // honest: never known synchronously (Q3)
    expect(result.launch.ok).toBe(true);

    const systemdCall = fake.calls.find((c) => c[0] === "systemd-run") as string[];
    const dashIdx = systemdCall.indexOf("--");
    const claudeArgs = systemdCall.slice(dashIdx + 3); // after "--", "claude", "--bg"
    expect(claudeArgs).toEqual([]); // FALSIFIER: any extra argv element here is a B8 violation
  });

  test("with a name: the agent holds it", async () => {
    const dir = await makeTempDir();
    const result = await create(baseDeps(dir, makeFakeClaude().runCommand), KEY, "bob");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.agent.name).toBe("bob");
  });

  test("refused: name taken in this directory — no agent created", async () => {
    const dir = await makeTempDir();
    const deps = baseDeps(dir, makeFakeClaude().runCommand);
    await seedAgent(deps.agentsPath, makeAgent({ id: "@existing0000000000", name: "taken" }));
    const result = await create(deps, KEY, "taken");
    expect(result.ok).toBe(false);

    const store = await loadAgents(deps.agentsPath);
    if (store.status === "loaded") expect(Object.keys(store.state.agents).length).toBe(1); // unchanged
  });

  test("refused: reserved word", async () => {
    const dir = await makeTempDir();
    const result = await create(baseDeps(dir, makeFakeClaude().runCommand), KEY, "archive");
    expect(result.ok).toBe(false);
  });

  test("launch failure is reported honestly, but the agent record still exists (recoverable via `on`)", async () => {
    const dir = await makeTempDir();
    const deps = baseDeps(dir, async (argv: string[]) => {
      if (argv[0] === "systemd-run") return { exitCode: 1, stdout: "", stderr: "systemd-run: permission denied" };
      throw new Error(`unexpected argv ${JSON.stringify(argv)}`);
    });
    const result = await create(deps, KEY);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.launch.ok).toBe(false);
      const store = await loadAgents(deps.agentsPath);
      if (store.status === "loaded") expect(store.state.agents[result.agent.id]?.state).toBe("on");
    }
  });
});

// --- on: resume-id routes through exactly one function, B8, no-change, archived refusal ---

describe("on", () => {
  test("restore: argv is EXACTLY --resume <durableSessionId> — the resume id is never hard-coded inline in agent-actions.ts", async () => {
    const source = await readFile(join(import.meta.dir, "..", "..", "src", "agent-actions.ts"), "utf8");
    // PROBE CONTROL: confirm the scan can find a known-present string first.
    expect(source).toContain("sessionIdToResume");
    // FALSIFIER: a direct `.durableSessionId` reference here would mean the
    // resume-id decision has more than one call site (it lives ONLY in
    // agent-lifecycle.ts's decideOn, which this file calls into).
    expect(source).not.toContain(".durableSessionId");

    const dir = await makeTempDir();
    const deps = baseDeps(dir, makeFakeClaude().runCommand);
    await seedAgent(deps.agentsPath, makeAgent({ id: "@a1", state: "off", durableSessionId: "durable-xyz" }));
    const result = await on(deps, KEY, "@a1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.kind).toBe("turn-on");
      expect(result.launchIssued).toBe(true);
    }
  });

  test("fresh (no durable session yet): argv has NO --resume and NO other args", async () => {
    const dir = await makeTempDir();
    const fake = makeFakeClaude();
    const deps = baseDeps(dir, fake.runCommand);
    await seedAgent(deps.agentsPath, makeAgent({ id: "@a1", state: "off", durableSessionId: undefined }));
    await on(deps, KEY, "@a1");

    const systemdCall = fake.calls.find((c) => c[0] === "systemd-run") as string[];
    const dashIdx = systemdCall.indexOf("--");
    expect(systemdCall.slice(dashIdx + 3)).toEqual([]);
  });

  test("no-change: already on, healthy (no launch issued, nothing reported as cleared)", async () => {
    const dir = await makeTempDir();
    const fake = makeFakeClaude();
    const deps = baseDeps(dir, fake.runCommand);
    await seedAgent(deps.agentsPath, makeAgent({ id: "@a1", state: "on", durableSessionId: "d1", liveSessionId: "d1" }));
    const result = await on(deps, KEY, "@a1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.kind).toBe("no-change");
      expect(result.launchIssued).toBe(false);
      expect(result.wedgeCleared).toBe(false);
    }
    expect(fake.calls.length).toBe(0); // nothing was launched or listed
  });

  test("refused: archived", async () => {
    const dir = await makeTempDir();
    const deps = baseDeps(dir, makeFakeClaude().runCommand);
    await seedAgent(deps.agentsPath, makeAgent({ id: "@a1", state: "archived" }));
    const result = await on(deps, KEY, "@a1");
    expect(result.ok).toBe(false);
  });
});

// --- off / archive / delete share ONE stop path (DoD item 2) -------------

describe("off, archive and delete all stop a session through the IDENTICAL `stopLiveSession` function", () => {
  test("stopLiveSession: exact sessionId match against a listing, then stop that entry's short id — never cwd", async () => {
    const fake = makeFakeClaude();
    fake.listing.push({ id: "short-9", sessionId: "live-9", cwd: "/somewhere/else", startedAt: 1, kind: "background" });
    const deps = baseDeps(await makeTempDir(), fake.runCommand);
    const outcome = await stopLiveSession(deps, "live-9");
    expect(outcome.kind).toBe("stopped");
    expect(fake.calls).toEqual([
      ["claude", "agents", "--json"],
      ["claude", "stop", "short-9"],
    ]);
  });

  test("off calls stopLiveSession and clears liveSessionId on success", async () => {
    const dir = await makeTempDir();
    const fake = makeFakeClaude();
    fake.listing.push({ id: "short-1", sessionId: "live-1", cwd: KEY, startedAt: 1, kind: "background" });
    const deps = baseDeps(dir, fake.runCommand);
    await seedAgent(deps.agentsPath, makeAgent({ id: "@a1", state: "on", liveSessionId: "live-1" }));

    const result = await off(deps, KEY, "@a1");
    expect(result.ok).toBe(true);
    if (result.ok && result.kind === "turned-off") expect(result.stop.kind).toBe("stopped");
    expect(fake.calls).toEqual([
      ["claude", "agents", "--json"],
      ["claude", "stop", "short-1"],
    ]);

    const store = await loadAgents(deps.agentsPath);
    if (store.status === "loaded") {
      expect(store.state.agents["@a1"]?.state).toBe("off");
      expect(store.state.agents["@a1"]?.liveSessionId).toBeUndefined();
    }
  });

  test("archive calls the SAME stop sequence as off, for an equivalent fixture", async () => {
    const dir = await makeTempDir();
    const fake = makeFakeClaude();
    fake.listing.push({ id: "short-2", sessionId: "live-2", cwd: KEY, startedAt: 1, kind: "background" });
    const deps = baseDeps(dir, fake.runCommand);
    await seedAgent(deps.agentsPath, makeAgent({ id: "@a1", state: "on", liveSessionId: "live-2" }));

    const result = await archive(deps, KEY, "@a1");
    expect(result.ok).toBe(true);
    if (result.ok && result.kind === "archived") expect(result.stop.kind).toBe("stopped");
    expect(fake.calls).toEqual([
      ["claude", "agents", "--json"],
      ["claude", "stop", "short-2"],
    ]); // IDENTICAL shape to off's own call sequence above
  });

  test("delete calls the SAME stop sequence too, then removes the record and retires the id", async () => {
    const dir = await makeTempDir();
    const fake = makeFakeClaude();
    fake.listing.push({ id: "short-3", sessionId: "live-3", cwd: KEY, startedAt: 1, kind: "background" });
    const deps = baseDeps(dir, fake.runCommand);
    await seedAgent(deps.agentsPath, makeAgent({ id: "@a1", state: "on", liveSessionId: "live-3" }));

    const result = await deleteAgent(deps, KEY, "@a1");
    expect(result.ok).toBe(true);
    if (result.ok && result.kind === "deleted") expect(result.stop.kind).toBe("stopped");
    expect(fake.calls).toEqual([
      ["claude", "agents", "--json"],
      ["claude", "stop", "short-3"],
    ]);

    const store = await loadAgents(deps.agentsPath);
    if (store.status === "loaded") {
      expect("@a1" in store.state.agents).toBe(false);
      expect(store.state.retiredIds).toContain("@a1");
    }
  });

  test("off: nothing to stop when there is no live session — stop.kind is 'nothing-to-stop', no listing call at all", async () => {
    const dir = await makeTempDir();
    const fake = makeFakeClaude();
    const deps = baseDeps(dir, fake.runCommand);
    await seedAgent(deps.agentsPath, makeAgent({ id: "@a1", state: "on", liveSessionId: undefined }));
    const result = await off(deps, KEY, "@a1");
    expect(result.ok).toBe(true);
    if (result.ok && result.kind === "turned-off") expect(result.stop.kind).toBe("nothing-to-stop");
    expect(fake.calls.length).toBe(0);
  });

  test("off: session already gone from a SUCCESSFUL listing — liveSessionId cleared", async () => {
    const dir = await makeTempDir();
    const deps = baseDeps(await makeTempDir(), makeFakeClaude().runCommand); // empty listing
    await seedAgent(deps.agentsPath, makeAgent({ id: "@a1", state: "on", liveSessionId: "vanished" }));
    const result = await off(deps, KEY, "@a1");
    expect(result.ok).toBe(true);
    if (result.ok && result.kind === "turned-off") expect(result.stop.kind).toBe("already-gone");
    const store = await loadAgents(deps.agentsPath);
    if (store.status === "loaded") expect(store.state.agents["@a1"]?.liveSessionId).toBeUndefined();
  });

  test("off: a LISTING FAILURE is reported distinctly and liveSessionId is LEFT ALONE (BAKR-17 Q2: never collapse to 'nothing running')", async () => {
    const dir = await makeTempDir();
    const fake = makeFakeClaude({ failListing: true });
    const deps = baseDeps(dir, fake.runCommand);
    await seedAgent(deps.agentsPath, makeAgent({ id: "@a1", state: "on", liveSessionId: "live-1" }));
    const result = await off(deps, KEY, "@a1");
    expect(result.ok).toBe(true);
    if (result.ok && result.kind === "turned-off") expect(result.stop.kind).toBe("listing-failed");
    const store = await loadAgents(deps.agentsPath);
    if (store.status === "loaded") {
      expect(store.state.agents["@a1"]?.state).toBe("off"); // the INTENT is still recorded
      expect(store.state.agents["@a1"]?.liveSessionId).toBe("live-1"); // but the outcome is honest: unknown, so untouched — a retry is meaningful
    }
  });

  test("off: a failed `claude stop` is reported and liveSessionId is left alone so a retry is meaningful", async () => {
    const dir = await makeTempDir();
    const fake = makeFakeClaude({ stopBehavior: () => ({ ok: false, error: "claude: no such session" }) });
    fake.listing.push({ id: "short-4", sessionId: "live-4", cwd: KEY, startedAt: 1, kind: "background" });
    const deps = baseDeps(dir, fake.runCommand);
    await seedAgent(deps.agentsPath, makeAgent({ id: "@a1", state: "on", liveSessionId: "live-4" }));
    const result = await off(deps, KEY, "@a1");
    if (result.ok && result.kind === "turned-off") expect(result.stop.kind).toBe("stop-failed");
    const store = await loadAgents(deps.agentsPath);
    if (store.status === "loaded") expect(store.state.agents["@a1"]?.liveSessionId).toBe("live-4");
  });

  test("delete: when the stop cannot be confirmed, the agent is PARKED as archived, not removed — retrying delete is meaningful", async () => {
    const dir = await makeTempDir();
    const fake = makeFakeClaude({ failListing: true });
    const deps = baseDeps(dir, fake.runCommand);
    await seedAgent(deps.agentsPath, makeAgent({ id: "@a1", state: "on", liveSessionId: "live-5" }));
    const result = await deleteAgent(deps, KEY, "@a1");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.kind).toBe("parked");
    const store = await loadAgents(deps.agentsPath);
    if (store.status === "loaded") {
      expect(store.state.agents["@a1"]?.state).toBe("archived"); // parked, not removed
      expect(store.state.retiredIds).not.toContain("@a1");
    }

    // Retry, now with a working listing — completes the delete.
    const fake2 = makeFakeClaude();
    fake2.listing.push({ id: "short-5", sessionId: "live-5", cwd: KEY, startedAt: 1, kind: "background" });
    const retryDeps = { ...deps, runCommand: fake2.runCommand };
    const retryResult = await deleteAgent(retryDeps, KEY, "@a1");
    expect(retryResult.ok).toBe(true);
    if (retryResult.ok) expect(retryResult.kind).toBe("deleted");
  });

  test("delete leaves Claude Code's own conversation storage untouched — nothing in this file references it at all", async () => {
    const source = await readFile(join(import.meta.dir, "..", "..", "src", "agent-actions.ts"), "utf8");
    expect(source.toLowerCase()).not.toContain(".claude/projects"); // Claude Code's own per-cwd conversation store path shape
    expect(source).not.toContain("rm(");
    expect(source).not.toContain("unlink");
  });
});

// --- archive / unarchive lifecycle, keeping the name --------------------

describe("archive / unarchive", () => {
  test("archive keeps the name; unarchive lands on off, never on", async () => {
    const dir = await makeTempDir();
    const deps = baseDeps(dir, makeFakeClaude().runCommand);
    await seedAgent(deps.agentsPath, makeAgent({ id: "@a1", state: "on", name: "keepme" }));

    const archived = await archive(deps, KEY, "@a1");
    expect(archived.ok).toBe(true);
    if (archived.ok && archived.kind === "archived") expect(archived.agent.name).toBe("keepme");

    const unarchived = await unarchive(deps, KEY, "@a1");
    expect(unarchived.ok).toBe(true);
    if (unarchived.ok) {
      expect(unarchived.agent.state).toBe("off");
      expect(unarchived.agent.name).toBe("keepme");
    }
  });

  test("unarchive refused on a non-archived agent", async () => {
    const dir = await makeTempDir();
    const deps = baseDeps(dir, makeFakeClaude().runCommand);
    await seedAgent(deps.agentsPath, makeAgent({ id: "@a1", state: "off" }));
    const result = await unarchive(deps, KEY, "@a1");
    expect(result.ok).toBe(false);
  });

  test("rename refuses a taken name held by an ARCHIVED agent (B4)", async () => {
    const dir = await makeTempDir();
    const deps = baseDeps(dir, makeFakeClaude().runCommand);
    await seedAgent(deps.agentsPath, makeAgent({ id: "@a1" }));
    await seedAgent(deps.agentsPath, makeAgent({ id: "@a2", name: "held", state: "archived" }));
    const result = await rename(deps, KEY, "@a1", "held");
    expect(result.ok).toBe(false);
  });
});

// --- rename / name alias, persisted through the real store --------------

describe("rename / name", () => {
  test("name (the alias) and rename are the same function — persisted identically", async () => {
    expect(nameVerb).toBe(rename);
    const dir = await makeTempDir();
    const deps = baseDeps(dir, makeFakeClaude().runCommand);
    await seedAgent(deps.agentsPath, makeAgent({ id: "@a1" }));
    const result = await nameVerb(deps, KEY, "@a1", "firstname");
    expect(result.ok).toBe(true);
    const store = await loadAgents(deps.agentsPath);
    if (store.status === "loaded") expect(store.state.agents["@a1"]?.name).toBe("firstname");
  });
});

// --- list: directory-scoped, archived included (R10) ---------------------

describe("list", () => {
  test("scoped to the given directory, archived included, another directory's agents excluded", async () => {
    const dir = await makeTempDir();
    const deps = baseDeps(dir, makeFakeClaude().runCommand);
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
    const deps = baseDeps(dir, makeFakeClaude().runCommand);
    await seedAgent(deps.agentsPath, makeAgent({ id: "@a1", state: "on", durableSessionId: "d1", liveSessionId: "l1" }));
    const result = await attachTarget(deps, KEY, "@a1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.liveSessionId).toBe("l1");
      expect(result.durableSessionId).toBe("d1");
    }
  });

  test("off: refused with a message pointing at `on`, never silently started", async () => {
    const dir = await makeTempDir();
    const deps = baseDeps(dir, makeFakeClaude().runCommand);
    await seedAgent(deps.agentsPath, makeAgent({ id: "@a1", state: "off" }));
    const result = await attachTarget(deps, KEY, "@a1");
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
    const deps = baseDeps(dir, makeFakeClaude().runCommand);

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
