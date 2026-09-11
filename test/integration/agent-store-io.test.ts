import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyAgentStore, putAgent, type AgentRecord } from "../../src/agent-model";
import { load, save, withAgentStoreLock } from "../../src/agent-store-io";
import type { ClaimKey } from "../../src/claim-key-resolve";

const cleanupDirs: string[] = [];

afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bakr-agent-store-io-"));
  cleanupDirs.push(dir);
  return dir;
}

function makeAgent(id: string): AgentRecord {
  return { id, name: undefined, directory: "/x" as ClaimKey, state: "on", createdAt: 1, durableSessionId: undefined, liveSessionId: undefined };
}

describe("load: missing / malformed / loaded are three distinct outcomes", () => {
  test("a missing file is 'missing' — a success, not an error", async () => {
    const dir = await makeTempDir();
    expect(await load(join(dir, "does-not-exist.json"))).toEqual({ status: "missing" });
  });

  test("a file that isn't valid JSON is 'malformed'", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "agents.json");
    await writeFile(path, "{ not json", "utf8");
    expect((await load(path)).status).toBe("malformed");
  });

  test("valid JSON with the wrong shape is 'malformed' — including a malformed file in the NEW format specifically (AC6)", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "agents.json");
    await writeFile(path, JSON.stringify({ version: 1, agents: { "@x": { id: "@x" } }, launches: [] }), "utf8");
    expect((await load(path)).status).toBe("malformed");
  });

  test("a well-formed store is 'loaded'", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "agents.json");
    await save(path, putAgent(emptyAgentStore(), makeAgent("@a1")));
    const result = await load(path);
    expect(result.status).toBe("loaded");
    if (result.status === "loaded") expect(Object.keys(result.state.agents)).toEqual(["@a1"]);
  });
});

describe("save: atomic write leaves no trace of the temp file, and creates its parent directory", () => {
  test("after save, the directory contains only the final file", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "agents.json");
    await save(path, emptyAgentStore());
    expect(await readdir(dir)).toEqual(["agents.json"]);
  });

  test("save creates its parent directory when absent", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "bakr", "agents.json");
    await save(path, emptyAgentStore());
    expect((await load(path)).status).toBe("loaded");
  });
});

describe("AC6: a malformed store is never overwritten by withAgentStoreLock", () => {
  test("withAgentStoreLock reports 'malformed' and never calls save (the file on disk is byte-for-byte unchanged)", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "agents.json");
    const original = "{ not json at all";
    await writeFile(path, original, "utf8");

    let mutateCalled = false;
    const result = await withAgentStoreLock(path, (current) => {
      mutateCalled = true;
      return { state: current, result: undefined };
    });

    expect(result.status).toBe("malformed");
    expect(mutateCalled).toBe(false); // never even reaches the mutation
    const raw = await Bun.file(path).text();
    expect(raw).toBe(original); // byte-for-byte unchanged — never written to
    // No lock file left behind either.
    expect(await readdir(dir)).toEqual(["agents.json"]);
  });
});

describe("withAgentStoreLock: single-process read-modify-write", () => {
  test("mutate receives the CURRENT on-disk state, and its result is saved atomically", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "agents.json");
    await save(path, putAgent(emptyAgentStore(), makeAgent("@existing")));

    const result = await withAgentStoreLock(path, (current) => {
      const next = putAgent(current, makeAgent("@new"));
      return { state: next, result: Object.keys(next.agents).length };
    });

    expect(result).toEqual({ status: "ok", result: 2 });
    const reloaded = await load(path);
    expect(reloaded.status).toBe("loaded");
    if (reloaded.status === "loaded") expect(Object.keys(reloaded.state.agents).sort()).toEqual(["@existing", "@new"]);
  });

  test("no lock file is left behind after a successful mutation", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "agents.json");
    await withAgentStoreLock(path, (current) => ({ state: current, result: undefined }));
    expect(await readdir(dir)).toEqual(["agents.json"]);
  });

  test("sequential mutations against a missing file each see a fresh, correct state (first sees empty, second sees the first's write)", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "agents.json");

    await withAgentStoreLock(path, (current) => {
      expect(Object.keys(current.agents)).toEqual([]);
      return { state: putAgent(current, makeAgent("@a1")), result: undefined };
    });
    await withAgentStoreLock(path, (current) => {
      expect(Object.keys(current.agents)).toEqual(["@a1"]);
      return { state: putAgent(current, makeAgent("@a2")), result: undefined };
    });

    const final = await load(path);
    expect(final.status).toBe("loaded");
    if (final.status === "loaded") expect(Object.keys(final.state.agents).sort()).toEqual(["@a1", "@a2"]);
  });
});

describe("withAgentStoreLock: mutual exclusion within one process", () => {
  test("two concurrent mutations against the SAME store never interleave — the second always sees the first's completed write (the lost-update guard, in-process)", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "agents.json");
    await save(path, emptyAgentStore());

    // Two concurrent increments — without the lock, both could read count=0 and both write count=1, losing one increment.
    const increment = () =>
      withAgentStoreLock(path, (current) => {
        const count = Object.keys(current.agents).length;
        const next = putAgent(current, makeAgent(`@agent-${count}`));
        return { state: next, result: undefined };
      });

    await Promise.all([increment(), increment(), increment(), increment(), increment()]);

    const final = await load(path);
    expect(final.status).toBe("loaded");
    if (final.status === "loaded") expect(Object.keys(final.state.agents)).toHaveLength(5); // every increment landed — none lost
  });
});

describe("stale lock recovery", () => {
  test("a lock file older than staleLockMs is stolen rather than waited on forever", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "agents.json");
    await save(path, emptyAgentStore());

    // Simulate a crashed holder: a lock file with an old timestamp.
    const lockPath = `${path}.lock`;
    await writeFile(lockPath, JSON.stringify({ pid: 999999, acquiredAt: Date.now() - 60_000 }), "utf8");

    const result = await withAgentStoreLock(path, (current) => ({ state: putAgent(current, makeAgent("@a1")), result: "done" }), { staleLockMs: 1000, acquireTimeoutMs: 2000 });
    expect(result).toEqual({ status: "ok", result: "done" });
  });

  test("a HEALTHY (fresh) lock is NOT stolen — a genuinely concurrent holder blocks the caller until the timeout, proving staleness alone (not mere presence) triggers the steal", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "agents.json");
    await save(path, emptyAgentStore());
    const lockPath = `${path}.lock`;
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }), "utf8");

    await expect(withAgentStoreLock(path, (current) => ({ state: current, result: undefined }), { staleLockMs: 60_000, acquireTimeoutMs: 200 })).rejects.toThrow(/timed out/);

    await rm(lockPath, { force: true });
  });
});
