import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claim, emptyStore, lookup } from "../../src/claim-model";
import { load, save } from "../../src/claim-store-io";
import type { ClaimKey } from "../../src/claim-key-resolve";

const cleanupDirs: string[] = [];

afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bakr-claim-store-io-"));
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
    const path = join(dir, "claims.json");
    await writeFile(path, "{ this is not json", "utf8");
    const result = await load(path);
    expect(result.status).toBe("malformed");
  });

  test("valid JSON with the wrong shape is 'malformed'", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "claims.json");
    await writeFile(path, JSON.stringify({ totally: "wrong" }), "utf8");
    const result = await load(path);
    expect(result.status).toBe("malformed");
  });

  test("a well-formed store is 'loaded' with the matching state", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "claims.json");
    const key = "/home/alice/project" as ClaimKey;
    const { state } = claim(emptyStore(), key, 1234);
    await save(path, state);

    const result = await load(path);
    expect(result.status).toBe("loaded");
    if (result.status === "loaded") {
      expect(lookup(result.state, key)).toEqual({ key, claimedAt: 1234 });
    }
  });

  test("these are three distinct status literals, not two with an overloaded meaning", () => {
    const statuses: Array<"missing" | "malformed" | "loaded"> = ["missing", "malformed", "loaded"];
    expect(new Set(statuses).size).toBe(3);
  });
});

describe("save: atomic write leaves no trace of the temp file", () => {
  test("after save, the directory contains only the final file — no leftover .*.tmp", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "claims.json");
    await save(path, emptyStore());

    const entries = await readdir(dir);
    expect(entries).toEqual(["claims.json"]);
  });

  test("save creates its parent directory when it does not yet exist (the real XDG_STATE_HOME/bakr case on first run)", async () => {
    const dir = await makeTempDir();
    const nested = join(dir, "bakr");
    const path = join(nested, "claims.json");

    await save(path, emptyStore());

    const result = await load(path);
    expect(result.status).toBe("loaded");
  });

  test("save + load round-trips a store with claims, in one process", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "claims.json");
    const keyA = "/a" as ClaimKey;
    const keyB = "/b" as ClaimKey;

    const { state: s1 } = claim(emptyStore(), keyA, 1);
    const { state: s2 } = claim(s1, keyB, 2);
    await save(path, s2);

    const result = await load(path);
    expect(result.status).toBe("loaded");
    if (result.status === "loaded") {
      expect(lookup(result.state, keyA)).toEqual({ key: keyA, claimedAt: 1 });
      expect(lookup(result.state, keyB)).toEqual({ key: keyB, claimedAt: 2 });
    }
  });

  test("a second save overwrites the first atomically — the reader always sees one complete generation, never a mix", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "claims.json");
    const keyA = "/a" as ClaimKey;
    const keyB = "/b" as ClaimKey;

    await save(path, claim(emptyStore(), keyA, 1).state);
    await save(path, claim(emptyStore(), keyB, 2).state);

    const result = await load(path);
    expect(result.status).toBe("loaded");
    if (result.status === "loaded") {
      expect(lookup(result.state, keyA)).toBeUndefined();
      expect(lookup(result.state, keyB)).toEqual({ key: keyB, claimedAt: 2 });
    }
  });
});
