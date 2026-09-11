// AC9 (B7): src/daemon.ts imports and calls no stop path. Falsifier: any
// `stopSession` import or call, or any `claude stop` / `systemctl --user
// stop` construction anywhere in this file. Static source inspection
// rather than a runtime mock, because the guarantee is about what the code
// CAN do, not merely what one particular test run happened to observe it
// do — a mock-based test only proves "didn't call it this time," while a
// source scan proves "cannot call it at all."
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const DAEMON_SOURCE_PATH = join(import.meta.dir, "..", "..", "src", "daemon.ts");

describe("AC9: src/daemon.ts imports and calls no stop path", () => {
  test("no `stopSession` import, no `stopSession(` call, and no literal `claude stop` / `systemctl --user stop` construction", async () => {
    const source = await readFile(DAEMON_SOURCE_PATH, "utf8");

    // PROBE CONTROL: confirm this file DOES successfully find an unrelated, known-present string, so an empty-match bug in the check itself (e.g. a wrong path) can't silently pass by finding nothing to look for in the first place.
    expect(source).toContain("runReconcileCycle");

    expect(source).not.toMatch(/stopSession/);
    expect(source).not.toMatch(/["']claude["'],\s*["']stop["']/); // no `["claude", "stop"]`-shaped argv construction
    expect(source.toLowerCase()).not.toContain("systemctl");
  });
});
