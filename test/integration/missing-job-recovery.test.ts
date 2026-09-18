// BAKR-22, the epic's "missing job with a live conversation" condition.
// Under `claude respawn`, a removed job entry made respawn refuse with "No
// job matching", and the OPERATOR's `on` recovered through an explicit,
// reported `forkFrom` while the loop (daemon.ts) never did so automatically.
//
// UNDER HERDR: a restore is `claude --resume <session>` in a new pane, which
// has no job registry and never prints "No job matching", so `on`'s
// missing-job route is unreachable. Its test ("on() recovers via an explicit,
// REPORTED forkFrom when respawn says 'No job matching'") was retired rather
// than kept alive by faking the old error text. What still applies, and is
// kept: the RECONCILE LOOP never escapes a failed restore into a fork on its
// own — even when a resumable transcript exists, which is exactly when an
// escape would pick `--fork-session`.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyAgentStore, putAgent, type AgentRecord } from "../../src/agent-model";
import { save as saveAgents, load as loadAgents } from "../../src/agent-store-io";
import { claim, emptyStore } from "../../src/claim-model";
import { save as saveClaims } from "../../src/claim-store-io";
import { initialDaemonState, runReconcileCycle, type DaemonDeps } from "../../src/daemon";
import type { ClaimKey } from "../../src/claim-key-resolve";
import type { OrphanProbeDeps } from "../../src/orphan-probe";
import type { TranscriptProbeDeps } from "../../src/transcript-probe";
import { makeFakeHost } from "../support/fake-host";

const alwaysPresentProbeDeps: OrphanProbeDeps = { stat: async () => ({ dev: 1, ino: 1, isDirectory: () => true }) };
const KEY = "/claimed/dir" as ClaimKey;
const AGENT_ID = "@missing-job-agent";
const SHORT_ID = "goneshort";
const SESSION_ID = "gone-session-uuid";
/** What claude prints when the session to resume cannot be found — the herdr-era counterpart of a missing job. */
const RESUME_FAILURE = `No conversation found with session ID: ${SESSION_ID}`;

const cleanupDirs: string[] = [];
afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});
async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bakr-missing-job-test-"));
  cleanupDirs.push(dir);
  return dir;
}

function agentWithRestoreTarget(): AgentRecord {
  return { id: AGENT_ID, name: undefined, directory: KEY, state: "on", createdAt: 1, birthSessionId: "birth", restoreTarget: { sessionId: SESSION_ID, shortId: SHORT_ID } };
}

const hasTranscript: TranscriptProbeDeps = { listProjectDirs: async () => ({ ok: true, dirs: ["-tmp-dir"] }), transcriptExistsIn: async () => ({ ok: true, exists: true }) };

describe("a failed restore in the reconcile loop (BAKR-22)", () => {
  test("the RECONCILE LOOP (daemon.ts) never escapes automatically — a resume that fails to start is just a typed refusal there, no forkFrom, per B7/B13, even with a resumable transcript", async () => {
    const dir = await makeTempDir();
    await saveClaims(join(dir, "claims.json"), claim(emptyStore(), KEY, 1).state);
    await saveAgents(join(dir, "agents.json"), putAgent(emptyAgentStore(), agentWithRestoreTarget()));

    const fake = makeFakeHost({ failStart: RESUME_FAILURE });
    let counter = 0;
    const deps: DaemonDeps = {
      runCommand: fake.runCommand,
      claimsPath: join(dir, "claims.json"),
      agentsPath: join(dir, "agents.json"),
      sessionSlotsPath: join(dir, "session-slots.json"),
      now: () => 1_700_000_000_000,
      generateAttemptId: () => `attempt-${counter++}`,
      randomBytes: (n) => new Uint8Array(n).fill(1),
      probeDeps: alwaysPresentProbeDeps,
      transcriptProbeDeps: hasTranscript,
      launchConfigDeps: { readConfigFile: async () => undefined },
    };

    await runReconcileCycle(initialDaemonState(), deps);

    // Exactly the one restore attempt. Falsifier: if the loop escaped
    // automatically, a second start carrying `--fork-session` would follow.
    expect(fake.starts()).toEqual([["--resume", SESSION_ID]]);

    const loaded = await loadAgents(join(dir, "agents.json"));
    if (loaded.status !== "loaded") throw new Error("expected loaded store");
    const forkAttempt = loaded.state.launches.find((l) => l.attemptKey?.kind === "forkFrom");
    expect(forkAttempt).toBeUndefined();
    const respawnFailure = loaded.state.launches.find((l) => l.attemptKey?.kind === "respawn");
    expect(respawnFailure?.error).toContain(RESUME_FAILURE);
    // The session id is untouched: nothing was forked or minted in its place.
    expect(loaded.state.agents[AGENT_ID]?.restoreTarget).toEqual({ sessionId: SESSION_ID, shortId: SHORT_ID });
  });
});
