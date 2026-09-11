import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyAgentStore, putAgent, type AgentRecord } from "../../src/agent-model";
import { acquireAgentStoreLockForFixture, load, save, withAgentStoreLock } from "../../src/agent-store-io";
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
  return { id, name: undefined, directory: "/x" as ClaimKey, state: "on", createdAt: 1, birthSessionId: undefined, restoreTarget: undefined };
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
    // BAKR-20: acquiring the lock necessarily creates "agents.json.lock" (the flock needs an fd on
    // an existing-or-created file) and releasing it never unlinks that path (see agent-store-io.ts's
    // module comment on why unlinking a flocked file is unsafe) — so it persists even on this
    // malformed-store path, where nothing else was written.
    expect(await readdir(dir)).toEqual(["agents.json", "agents.json.lock"]);
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

  test("BAKR-20: the lock file PERSISTS after release (never unlinked), and a later acquire reuses it rather than recreating it", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "agents.json");
    const lockPath = `${path}.lock`;
    await save(path, emptyAgentStore()); // a real store must already exist for a no-op mutate to leave "agents.json" itself in place (Finding 3: a true no-op now skips the save entirely)

    await withAgentStoreLock(path, (current) => ({ state: current, result: undefined }));
    expect(await readdir(dir)).toEqual(["agents.json", "agents.json.lock"]);
    const inodeAfterFirst = (await stat(lockPath)).ino;

    await withAgentStoreLock(path, (current) => ({ state: current, result: undefined }));
    expect(await readdir(dir)).toEqual(["agents.json", "agents.json.lock"]);
    expect((await stat(lockPath)).ino).toBe(inodeAfterFirst); // same inode — reopened, never recreated
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

describe("BAKR-20 Finding 2: an unreadable lock file can no longer wedge the daemon — demonstrated as structurally moot under a kernel lock", () => {
  // Falsifiers, stated first: under the OLD scheme these two fixtures (an
  // empty lock file; a truncated-JSON lock file), each given an old mtime,
  // threw a timeout every time — see the ticket's own measurement. If this
  // mechanism regressed toward that shape, these tests would time out
  // (>= acquireTimeoutMs) instead of completing in well under it.
  const FIXTURE_ACQUIRE_TIMEOUT_MS = 1500;

  test("an EMPTY lock file with an old mtime acquires immediately — content is never consulted, so 'is this readable enough to judge?' cannot arise", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "agents.json");
    await save(path, emptyAgentStore());
    const lockPath = `${path}.lock`;
    await writeFile(lockPath, "", "utf8");
    const oldTime = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(lockPath, oldTime, oldTime);

    const start = Date.now();
    const result = await withAgentStoreLock(path, (current) => ({ state: putAgent(current, makeAgent("@a1")), result: "done" }), { acquireTimeoutMs: FIXTURE_ACQUIRE_TIMEOUT_MS });
    expect(result).toEqual({ status: "ok", result: "done" });
    expect(Date.now() - start).toBeLessThan(500); // nowhere near the timeout — there was never a real holder to wait on
  });

  test('a PARTIAL-JSON lock file (\'{"pid": 12\') with an old mtime acquires immediately — same reason', async () => {
    const dir = await makeTempDir();
    const path = join(dir, "agents.json");
    await save(path, emptyAgentStore());
    const lockPath = `${path}.lock`;
    await writeFile(lockPath, '{"pid": 12', "utf8");
    const oldTime = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(lockPath, oldTime, oldTime);

    const start = Date.now();
    const result = await withAgentStoreLock(path, (current) => ({ state: putAgent(current, makeAgent("@a1")), result: "done" }), { acquireTimeoutMs: FIXTURE_ACQUIRE_TIMEOUT_MS });
    expect(result).toEqual({ status: "ok", result: "done" });
    expect(Date.now() - start).toBeLessThan(500);
  });

  test("CONTROL: no pre-existing lock file at all also acquires immediately (same code path as the two fixtures above)", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "agents.json");
    await save(path, emptyAgentStore());
    const result = await withAgentStoreLock(path, (current) => ({ state: current, result: "done" }));
    expect(result).toEqual({ status: "ok", result: "done" });
  });

  test("CONTROL: a REAL, genuinely held lock (the same primitive production code uses, via acquireAgentStoreLockForFixture) DOES block a competing acquire until release — proving the three fixtures above are fast because there was truly no holder, not because acquisition is broken and always succeeds", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "agents.json");
    await save(path, emptyAgentStore());

    const held = await acquireAgentStoreLockForFixture(path);
    try {
      await expect(withAgentStoreLock(path, (current) => ({ state: current, result: undefined }), { acquireTimeoutMs: 200 })).rejects.toThrow(/timed out/);
    } finally {
      await held.release();
    }

    // Released — a fresh acquire now succeeds, and reuses (never recreates) the same lock path.
    const result = await withAgentStoreLock(path, (current) => ({ state: current, result: "done" }));
    expect(result).toEqual({ status: "ok", result: "done" });
  });
});
