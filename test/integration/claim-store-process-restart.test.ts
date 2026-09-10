// "The store round-trips through a process restart" (BAKR-10 definition
// of done, §4(b)). Deliberately two SEPARATE `bun` processes, spawned via
// `Bun.spawn` and awaited to exit — never two calls to save()/load() in
// this test's own process. The ticket is explicit that calling save() and
// load() in one process "is not a process restart and will not be
// accepted as one," so this file exists specifically to be the thing that
// would fail if this test regressed to that shortcut.
//
// What this demonstrates and what it does not: a real process restart,
// on the real filesystem, round-trips the store correctly. It does NOT
// demonstrate surviving an actual host reboot — this host carries a live
// shared fleet and must not be rebooted to test this. Reboot durability
// is argued from the XDG Base Directory specification plus the observed
// mount type of the real storage location (see the shipped doc), not
// observed directly. That distinction is written down here in exactly
// those terms, per the ticket's own instruction not to let the two be
// conflated.
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIXTURES_DIR = join(import.meta.dir, "fixtures");

interface FixtureResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runFixture(name: string, args: string[]): Promise<FixtureResult> {
  const proc = Bun.spawn(["bun", "run", join(FIXTURES_DIR, name), ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

describe("the claim store round-trips through a genuine process restart", () => {
  test(
    "a second, separate bun process loads exactly what a first, separate bun process claimed, saved, and exited",
    async () => {
      const claimsDir = await mkdtemp(join(tmpdir(), "bakr-process-restart-store-"));
      const claimedDir = await mkdtemp(join(tmpdir(), "bakr-process-restart-claimed-"));
      const claimsPath = join(claimsDir, "claims.json");

      try {
        const first = await runFixture("claim-and-save.ts", [claimsPath, claimedDir]);
        expect(first.stderr).toBe("");
        expect(first.code).toBe(0);
        const key = first.stdout;
        expect(key.length).toBeGreaterThan(0);

        // `first.code` above only resolves after `proc.exited` — the
        // first process has genuinely terminated before this line runs.
        const second = await runFixture("load-and-assert.ts", [claimsPath, key]);
        expect(second.stderr).toBe("");
        expect(second.code).toBe(0);

        const loadedClaim = JSON.parse(second.stdout);
        expect(loadedClaim.key).toBe(key);
        expect(loadedClaim.claimedAt).toBe(1234567890);
        expect(loadedClaim.agentIds).toEqual([]);
      } finally {
        await rm(claimsDir, { recursive: true, force: true });
        await rm(claimedDir, { recursive: true, force: true });
      }
    },
    20000,
  );
});
