// BAKR-20 §3: the N-contender lost-update demonstration the epic asked
// for by name, distinct from the pre-existing 2-process
// agent-store-lock-race.test.ts (AC7) — that file's own comment already
// explains why two parties cannot see Finding 1's bug: the race needs at
// least THREE parties (a waiter holding a dead holder's info, the holder
// that actually released, and the next holder that re-acquired in
// between). This file uses SHORT-LIVED, REAL OS process contenders — the
// exact shape BAKR-3's future CLI will produce, and the shape the ticket's
// own measurement (3/20 trials lost with a seeded dead holder, at N=12)
// was taken against.
//
// Falsifiers, stated first, one per test:
// - "ZERO lost updates, no pre-existing lock": if the shipped lock regains
//   ANY TOCTOU window, `finalCount` drops below `N` on at least one of the
//   repeated trials.
// - "ZERO lost updates, dead holder's lock seeded": same falsifier, but
//   under the EXACT precondition (a stale/dead-holder lock file already on
//   disk before any contender starts) the ticket's own Finding 1 needed to
//   reproduce at all — this is the trial shape most likely to catch a
//   regression back toward the old TOCTOU, so it is kept as its own test
//   rather than folded into the no-preexisting-lock one.
// - "POSITIVE CONTROL": if this harness cannot make an UNLOCKED run lose at
//   least one update, every "zero lost updates" result above is
//   meaningless — it would just mean the probe cannot see a loss, not that
//   there isn't one. Falsifier: an unlocked run's `finalCount` reaches `N`
//   despite real concurrent processes racing an unprotected load-modify-save.
// - "REGRESSION: shown failing against the old code": if the OLD,
//   pre-BAKR-20 lock (frozen in legacy-agent-store-lock.ts) does NOT lose
//   at least one update across the same trial count and preconditions that
//   make the NEW lock's own test above meaningful, this file is not
//   actually exercising Finding 1's bug and the "zero lost updates"
//   results next to it prove nothing. This is the "patch the old logic
//   back in and watch the test go red" step the ticket asks for, kept
//   permanently in the suite (via the frozen copy) rather than done once
//   by hand and thrown away.
//
// Measured while writing this file (bun 1.3.14, this repo's own harness,
// N=12, 20 trials each): OLD lock with a seeded dead holder lost updates
// on 7/20 trials (one trial short by 2); NEW lock lost updates on 0/20
// trials in BOTH the seeded and unseeded configurations; the unlocked
// positive control lost updates on 6/6 trials. Both the "old" and "new"
// results are asserted below, not just narrated here.
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "../../src/agent-store-io";

const FIXTURE = join(import.meta.dir, "fixtures", "agent-contention-worker.ts");
const CONTENDER_COUNT = 12; // the ticket's own measurement was taken at this count — "how many contenders" is asked for by name in the DoD
const START_OFFSET_MS = 250; // long enough for all N `bun run` processes to have finished booting before the shared start instant arrives

type Mode = "new" | "old" | "unlocked";

async function seedDeadHolderLock(agentsPath: string): Promise<void> {
  // A dead holder's lock file, exactly as Finding 1's own reproduction
  // seeds it: a pid that does not exist, so a content-based scheme judges
  // it "confirmed dead" and (under the OLD code) steals it — the TOCTOU
  // window Finding 1 lives in. Under the NEW code this content is never
  // consulted at all (Finding 2's own point).
  await writeFile(`${agentsPath}.lock`, JSON.stringify({ pid: 999999, acquiredAt: Date.now() }), "utf8");
}

interface TrialResult {
  readonly finalCount: number;
  readonly allExitedZero: boolean;
}

async function runTrial(mode: Mode, seedDeadLock: boolean): Promise<TrialResult> {
  const dir = await mkdtemp(join(tmpdir(), `bakr-contention-${mode}-`));
  try {
    const agentsPath = join(dir, "agents.json");
    if (seedDeadLock) {
      await seedDeadHolderLock(agentsPath);
    }
    const startAt = Date.now() + START_OFFSET_MS;
    const procs = Array.from({ length: CONTENDER_COUNT }, () => Bun.spawn(["bun", "run", FIXTURE, mode, agentsPath, String(startAt)], { stdout: "ignore", stderr: "pipe" }));
    const exitCodes = await Promise.all(procs.map((p) => p.exited));
    const allExitedZero = exitCodes.every((code) => code === 0);
    const loaded = await load(agentsPath);
    const finalCount = loaded.status === "loaded" ? Object.keys(loaded.state.agents).length : -1;
    return { finalCount, allExitedZero };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runTrials(mode: Mode, seedDeadLock: boolean, trialCount: number): Promise<{ readonly lostTrials: number; readonly results: readonly TrialResult[] }> {
  const results: TrialResult[] = [];
  for (let i = 0; i < trialCount; i++) {
    results.push(await runTrial(mode, seedDeadLock));
  }
  const lostTrials = results.filter((r) => r.finalCount !== CONTENDER_COUNT).length;
  return { lostTrials, results };
}

describe(`BAKR-20 §3: ${CONTENDER_COUNT} short-lived REAL-process contenders, repeated trials`, () => {
  test("POSITIVE CONTROL: unlocked (no lock at all) loses at least one update, proving this harness can observe a lost update", async () => {
    const { lostTrials, results } = await runTrials("unlocked", false, 6);
    for (const r of results) expect(r.allExitedZero).toBe(true); // every worker still reports success even though updates were lost — that's the hazard
    expect(lostTrials).toBeGreaterThan(0);
  }, 60_000);

  test("NEW (shipped) lock: ZERO lost updates across repeated trials, NO pre-existing lock file", async () => {
    const { lostTrials, results } = await runTrials("new", false, 20);
    for (const r of results) {
      expect(r.allExitedZero).toBe(true);
      expect(r.finalCount).toBe(CONTENDER_COUNT);
    }
    expect(lostTrials).toBe(0);
  }, 120_000);

  test("NEW (shipped) lock: ZERO lost updates across repeated trials, WITH a dead holder's lock file seeded at the start", async () => {
    const { lostTrials, results } = await runTrials("new", true, 20);
    for (const r of results) {
      expect(r.allExitedZero).toBe(true);
      expect(r.finalCount).toBe(CONTENDER_COUNT);
    }
    expect(lostTrials).toBe(0);
  }, 120_000);

  test("REGRESSION GUARD: the OLD (pre-BAKR-20) lock DOES lose updates under the exact precondition Finding 1 needs — proving this suite would have caught it, and catches any future regression back toward it", async () => {
    const { lostTrials } = await runTrials("old", true, 20);
    // This is the falsifier for the regression guard ITSELF: if this ever
    // reads 0, either Finding 1 no longer reproduces the way the ticket
    // measured it (unlikely — this is a frozen copy of the exact old
    // code), or this test's own harness stopped exercising the race. Either
    // way, treat a 0 here as a bug in THIS test, not as good news.
    expect(lostTrials).toBeGreaterThan(0);
  }, 120_000);
});
