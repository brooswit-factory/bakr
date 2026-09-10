import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginLaunch, emptySessionSlots, markLaunchStarted, resolveLaunch, sessionsOn } from "../../src/session-slots";
import { load, save } from "../../src/session-slots-store";
import type { ClaimKey } from "../../src/claim-key-resolve";

const cleanupDirs: string[] = [];

afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bakr-session-slots-io-"));
  cleanupDirs.push(dir);
  return dir;
}

describe("load: missing / malformed / loaded are three distinct outcomes", () => {
  test("a missing file is 'missing' — a success, not an error", async () => {
    const dir = await makeTempDir();
    const result = await load(join(dir, "does-not-exist.json"));
    expect(result).toEqual({ status: "missing" });
  });

  test("a file that isn't valid JSON is 'malformed', not silently treated as empty", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "session-slots.json");
    await writeFile(path, "{ this is not json", "utf8");
    const result = await load(path);
    expect(result.status).toBe("malformed");
  });

  test("valid JSON with the wrong shape is 'malformed'", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "session-slots.json");
    await writeFile(path, JSON.stringify({ totally: "wrong" }), "utf8");
    const result = await load(path);
    expect(result.status).toBe("malformed");
  });

  test("a well-formed store is 'loaded' with the matching state", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "session-slots.json");
    const key = "/home/alice/project" as ClaimKey;
    let state = emptySessionSlots();
    state = beginLaunch(state, key, undefined, "attempt-1", 1000);
    state = markLaunchStarted(state, "attempt-1", "short-1");
    state = resolveLaunch(state, "short-1", "session-uuid-1");
    await save(path, state);

    const result = await load(path);
    expect(result.status).toBe("loaded");
    if (result.status === "loaded") {
      expect(sessionsOn(result.state, key)).toEqual(["session-uuid-1"]);
    }
  });
});

describe("save: atomic write leaves no trace of the temp file", () => {
  test("after save, the directory contains only the final file — no leftover .*.tmp", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "session-slots.json");
    await save(path, emptySessionSlots());

    const entries = await readdir(dir);
    expect(entries).toEqual(["session-slots.json"]);
  });

  test("save creates its parent directory when it does not yet exist (the real XDG_STATE_HOME/bakr case on first run)", async () => {
    const dir = await makeTempDir();
    const nested = join(dir, "bakr");
    const path = join(nested, "session-slots.json");

    await save(path, emptySessionSlots());

    const result = await load(path);
    expect(result.status).toBe("loaded");
  });

  test("save + load round-trips a store with slots, in one process", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "session-slots.json");
    const keyA = "/a" as ClaimKey;
    const keyB = "/b" as ClaimKey;

    let state = emptySessionSlots();
    state = beginLaunch(state, keyA, undefined, "attempt-a", 1);
    state = markLaunchStarted(state, "attempt-a", "short-a");
    state = resolveLaunch(state, "short-a", "session-a");
    state = beginLaunch(state, keyB, undefined, "attempt-b", 2);
    state = markLaunchStarted(state, "attempt-b", "short-b");
    state = resolveLaunch(state, "short-b", "session-b");
    await save(path, state);

    const result = await load(path);
    expect(result.status).toBe("loaded");
    if (result.status === "loaded") {
      expect(sessionsOn(result.state, keyA)).toEqual(["session-a"]);
      expect(sessionsOn(result.state, keyB)).toEqual(["session-b"]);
    }
  });
});
