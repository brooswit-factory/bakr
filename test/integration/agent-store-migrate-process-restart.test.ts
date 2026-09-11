// AC1's own explicit requirement: "two separate process runs show the same
// agent ids (nothing re-minted)". An in-process test (agent-store-migrate.test.ts,
// unit-level) proves the pure function is deterministic given the same
// inputs, but never proves the ON-DISK migration is idempotent ACROSS a
// process boundary — this file closes that gap with two genuinely separate
// `bun` processes racing to migrate the SAME session-slots.json in
// sequence.
//
// Falsifier, stated first: if migration is not properly persisted-once
// (e.g. the lock/short-circuit in loadOrMigrateAgentStore is broken), the
// second process's run mints a DIFFERENT set of agent ids than the first.
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptySessionSlots, beginLaunch, markLaunchStarted, resolveLaunch, serializeSessionSlotsState } from "../../src/session-slots";
import type { ClaimKey } from "../../src/claim-key-resolve";

const FIXTURE = join(import.meta.dir, "fixtures", "migrate-and-print-ids.ts");
const KEY = "/claimed/dir" as ClaimKey;

async function runMigrateFixture(agentsPath: string, sessionSlotsPath: string): Promise<{ status: string; ids: string[] }> {
  const proc = Bun.spawn(["bun", "run", FIXTURE, agentsPath, sessionSlotsPath], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) throw new Error(`fixture exited ${exitCode}\nstdout: ${stdout}\nstderr: ${stderr}`);
  return JSON.parse(stdout.trim());
}

describe("AC1: two separate process runs show the same agent ids — nothing re-minted", () => {
  test("the first run migrates; the SECOND, fully separate process run reports the IDENTICAL agent ids", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bakr-migrate-restart-"));
    try {
      const agentsPath = join(dir, "agents.json");
      const sessionSlotsPath = join(dir, "session-slots.json");

      let slots = emptySessionSlots();
      slots = beginLaunch(slots, KEY, undefined, "a1", 1000);
      slots = markLaunchStarted(slots, "a1", "s1");
      slots = resolveLaunch(slots, "s1", "durable-1");
      slots = beginLaunch(slots, KEY, undefined, "a2", 1000);
      slots = markLaunchStarted(slots, "a2", "s2");
      slots = resolveLaunch(slots, "s2", "durable-2");
      await writeFile(sessionSlotsPath, serializeSessionSlotsState(slots), "utf8");

      const first = await runMigrateFixture(agentsPath, sessionSlotsPath);
      expect(first.status).toBe("migrated");
      expect(first.ids).toHaveLength(2);

      const second = await runMigrateFixture(agentsPath, sessionSlotsPath);
      expect(second.status).toBe("loaded"); // NOT "migrated" again
      expect(second.ids).toEqual(first.ids); // IDENTICAL ids — nothing re-minted
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 20000);
});
