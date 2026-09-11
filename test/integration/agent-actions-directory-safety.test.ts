// Criterion 7 (corrected, epic-wide, 2026-09-11): "nothing is written into
// a claimed directory" must be demonstrated with a recursive,
// content-sensitive snapshot (scripts/dir-snapshot.ts), not a bare
// directory `stat` — a directory's mtime/ctime is BLIND to an existing
// file being rewritten under the same name. See
// test/unit/dir-snapshot.test.ts for the instrument's own positive and
// negative controls.
//
// THIS FILE's scope, stated honestly (the criterion's own requirement):
// it proves bakr's OWN verbs — create, on, off, archive, delete — write
// nothing into the claimed directory across a realistic sequence of calls.
// It does NOT claim anything about what a real attached agent's own
// conversation might legitimately write there; `runCommand` is stubbed
// here (no real `claude` process runs), so this is scoped specifically to
// bakr's own machinery, complementing (not replacing) the live
// demonstration's real-process run in the PR body, which covers the same
// claim around two REAL `claude --bg` sessions.
//
// Falsifier: ANY snapshot pair across this sequence differing means bakr's
// own verb/lock/spawn-substrate code wrote into the claimed directory.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotDirectory } from "../../scripts/dir-snapshot";
import { archive, create, deleteAgent, off, on, unarchive, type AgentActionDeps } from "../../src/agent-actions";
import type { ClaimKey } from "../../src/claim-key-resolve";
import type { CommandResult, RunCommandOptions } from "../../src/spawn";

const cleanupDirs: string[] = [];
afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bakr-dir-safety-"));
  cleanupDirs.push(dir);
  return dir;
}

function makeFakeClaude() {
  const listing: { id: string; sessionId: string; cwd: string; startedAt: number; kind: string; pid?: number }[] = [];
  let n = 0;
  async function runCommand(argv: string[], opts: RunCommandOptions): Promise<CommandResult> {
    if (argv[0] === "claude" && argv[1] === "agents") return { exitCode: 0, stdout: JSON.stringify(listing), stderr: "" };
    if (argv[0] === "claude" && argv[1] === "stop") {
      const id = argv[2] as string;
      const idx = listing.findIndex((s) => s.id === id);
      if (idx !== -1) listing.splice(idx, 1);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (argv[0] === "systemd-run") {
      const shortId = `short-${n++}`;
      listing.push({ id: shortId, sessionId: `session-${shortId}`, cwd: opts.cwd ?? "", startedAt: 1, kind: "background", pid: 100 + n });
      return { exitCode: 0, stdout: `backgrounded · ${shortId} (idle — send a prompt to start)\n`, stderr: "" };
    }
    throw new Error(`unexpected argv ${JSON.stringify(argv)}`);
  }
  return { runCommand };
}

function makeDeps(agentsPath: string, runCommand: AgentActionDeps["runCommand"]): AgentActionDeps {
  let counter = 0;
  return {
    agentsPath,
    runCommand,
    now: () => 1_700_000_000_000,
    generateAttemptId: () => `attempt-${counter++}`,
    randomBytes: (n: number) => new Uint8Array(n).fill((counter += 1) & 0xff),
  };
}

describe("criterion 7 (corrected): nothing is written into the claimed directory across a real sequence of bakr's own verbs", () => {
  test("create -> on(no-op) -> off -> archive -> delete, snapshotted at every step, against a directory that ALREADY HAS CONTENT (so an in-place rewrite of an existing file would be visible)", async () => {
    const claimedDir = await makeDir();
    const stateDir = await makeDir();
    // Pre-existing content in the claimed directory — a real repo has
    // files already; this is also what makes the in-place-rewrite gap
    // observable at all (a directory snapshotDirectory takes of an EMPTY
    // tree can only detect additions, never a rewrite of something that
    // was not there to begin with).
    await writeFile(join(claimedDir, "README.md"), "# a real repo\n");
    await writeFile(join(claimedDir, ".gitignore"), "node_modules\n");

    const key = claimedDir as ClaimKey;
    const agentsPath = join(stateDir, "agents.json");
    const fake = makeFakeClaude();
    const deps = makeDeps(agentsPath, fake.runCommand);

    const snapshots: { step: string; hash: string }[] = [];
    async function snap(step: string): Promise<void> {
      snapshots.push({ step, hash: await snapshotDirectory(claimedDir) });
    }

    await snap("0-initial");

    const created = await create(deps, key);
    if (!created.ok) throw new Error("create failed");
    await snap("1-after-create");

    const onResult = await on(deps, key, created.agent.id); // already on — a deliberate no-op call
    if (!onResult.ok) throw new Error("on failed");
    await snap("2-after-on-noop");

    const offResult = await off(deps, key, created.agent.id);
    if (!offResult.ok) throw new Error("off failed");
    await snap("3-after-off");

    const archiveResult = await archive(deps, key, created.agent.id);
    if (!archiveResult.ok) throw new Error("archive failed");
    await snap("4-after-archive");

    const unarchived = await unarchive(deps, key, created.agent.id);
    if (!unarchived.ok) throw new Error("unarchive failed");
    await snap("5-after-unarchive");

    const deleteResult = await deleteAgent(deps, key, created.agent.id);
    if (!deleteResult.ok) throw new Error("delete failed");
    await snap("6-after-delete");

    const first = snapshots[0]?.hash;
    const mismatches = snapshots.filter((s) => s.hash !== first);
    if (mismatches.length > 0) {
      throw new Error(`claimed directory content changed at: ${mismatches.map((m) => m.step).join(", ")} — bakr wrote into a claimed directory`);
    }
    expect(mismatches.length).toBe(0);
    expect(snapshots.length).toBe(7); // sanity: every step actually ran and was snapshotted
  });

  test("SANITY CHECK on this exact fixture shape: if something DID rewrite a pre-existing file in the claimed directory in place, this harness's own snapshot WOULD catch it", async () => {
    const claimedDir = await makeDir();
    await writeFile(join(claimedDir, "README.md"), "# a real repo\n");
    const before = await snapshotDirectory(claimedDir);
    await writeFile(join(claimedDir, "README.md"), "# REWRITTEN in place, same name\n");
    const after = await snapshotDirectory(claimedDir);
    expect(after).not.toBe(before); // the harness CAN see this — not a probe that would pass either way
  });
});
