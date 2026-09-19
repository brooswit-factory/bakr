// A launch record with no outcome yet is also what ANOTHER process's launch
// looks like while it is still in flight (a CLI `on` waiting on its herdr
// pane). Measured 2026-09-18: the daemon marked butchr's in-flight restore
// "crashed" mid-launch, leaving a failed record and a stale pane handle. The
// daemon now treats such a record as wedged only once it is older than any
// launch could still be running.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claim, emptyStore } from "../../src/claim-model";
import { save as saveClaims } from "../../src/claim-store-io";
import { save as saveAgents, load as loadAgents } from "../../src/agent-store-io";
import { beginLaunch, emptyAgentStore, putAgent } from "../../src/agent-model";
import { initialDaemonState, runReconcileCycle, type DaemonDeps } from "../../src/daemon";
import type { ClaimKey } from "../../src/claim-key-resolve";
import { makeFakeHost } from "../support/fake-host";

const NOW = 1_700_000_000_000;
const KEY = "/claimed/butchr" as ClaimKey;
const cleanup: string[] = [];
afterEach(async () => { while (cleanup.length) await rm(cleanup.pop()!, { recursive: true, force: true }); });

async function cycleWithPendingRecordAged(ageMs: number) {
  const dir = await mkdtemp(join(tmpdir(), "bakr-inflight-"));
  cleanup.push(dir);
  await saveClaims(join(dir, "claims.json"), claim(emptyStore(), KEY, 1).state);
  const agent = { id: "@butchr", name: "butchr", directory: KEY, state: "on" as const, createdAt: 1, birthSessionId: "s1", restoreTarget: { sessionId: "s1", shortId: "old" } };
  // Another process is restoring this agent right now: its record has no outcome yet.
  await saveAgents(join(dir, "agents.json"), beginLaunch(putAgent(emptyAgentStore(), agent), agent.id, KEY, { kind: "respawn", shortId: "old" }, "in-flight", NOW - ageMs));
  const host = makeFakeHost();
  const deps: DaemonDeps = {
    runCommand: host.runCommand,
    claimsPath: join(dir, "claims.json"),
    agentsPath: join(dir, "agents.json"),
    sessionSlotsPath: join(dir, "session-slots.json"),
    now: () => NOW,
    generateAttemptId: () => "daemon-attempt",
    randomBytes: (n) => new Uint8Array(n),
    probeDeps: { stat: async () => ({ dev: 1, ino: 1, isDirectory: () => true }) },
    launchConfigDeps: { readConfigFile: async () => undefined },
  };
  // BAKR-33: `isFirstCycle: false` — this file's own scope is
  // `promoteWedgedLaunches`'s marking behavior specifically (see its module
  // doc), not this ticket's separate first-cycle-since-restart exception
  // (covered by daemon-no-wedge-clear.test.ts). Without opting out, an
  // 11-minute-old record that just got marked failed THIS cycle, with its
  // target genuinely absent (no pane in this fixture), would also qualify
  // for that exception on a literal first cycle — a real, intentional, but
  // orthogonal behavior this file isn't testing.
  await runReconcileCycle({ ...initialDaemonState(), isFirstCycle: false }, deps);
  const loaded = await loadAgents(join(dir, "agents.json"));
  if (loaded.status !== "loaded") throw new Error("store not loaded");
  return { launches: loaded.state.launches, host };
}

describe("a launch still in flight in another process", () => {
  test("is left alone by the daemon, and the daemon does not start a second restore beside it", async () => {
    const { launches, host } = await cycleWithPendingRecordAged(5_000);
    expect(launches.map((l) => [l.attemptId, l.error])).toEqual([["in-flight", undefined]]);
    expect(host.starts()).toEqual([]);
  });

  test("once older than any launch could run, it is recovered as wedged, as before", async () => {
    const { launches } = await cycleWithPendingRecordAged(11 * 60_000);
    const record = launches.find((l) => l.attemptId === "in-flight");
    expect(record?.error).toContain("ended before this launch's outcome was recorded");
  });
});
