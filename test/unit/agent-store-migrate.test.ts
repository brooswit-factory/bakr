import { describe, expect, test } from "bun:test";
import { migrateSessionSlots } from "../../src/agent-store-migrate";
import { emptySessionSlots, beginLaunch, markLaunchStarted, resolveLaunch, markLaunchFailed, parseSessionSlotsState } from "../../src/session-slots";
import type { ClaimKey } from "../../src/claim-key-resolve";

const KEY_A = "/home/alice/project" as ClaimKey;
const KEY_B = "/home/alice/other" as ClaimKey;

function fixedDeps(seed = 1) {
  let call = seed;
  return {
    now: () => 5_000_000,
    randomBytes: (n: number) => {
      call += 1;
      return new Uint8Array(n).fill(call & 0xff);
    },
  };
}

describe("migrateSessionSlots: AC1 — each of the three shapes the current parser accepts loads and becomes exactly one unnamed 'on' agent", () => {
  test("current v1 shape ({durableSessionId, liveSessionId})", () => {
    let slots = emptySessionSlots();
    slots = beginLaunch(slots, KEY_A, undefined, "attempt-1", 1000);
    slots = markLaunchStarted(slots, "attempt-1", "short-1");
    slots = resolveLaunch(slots, "short-1", "durable-and-live-1");

    const { state, summary } = migrateSessionSlots(slots, fixedDeps());
    const agents = Object.values(state.agents);
    expect(agents).toHaveLength(1);
    expect(agents[0]?.state).toBe("on");
    expect(agents[0]?.name).toBeUndefined();
    expect(agents[0]?.directory).toBe(KEY_A);
    // Session ids preserved BYTE-FOR-BYTE.
    expect(agents[0]?.durableSessionId).toBe("durable-and-live-1");
    expect(agents[0]?.liveSessionId).toBe("durable-and-live-1");
    expect(summary.agentsCreated).toBe(1);
    expect(summary.directories).toEqual([KEY_A]);
  });

  test("legacy bare-string onByKey entry (written by every build up to and including PR #8)", () => {
    const parsed = parseSessionSlotsState(JSON.stringify({ version: 1, onByKey: { [KEY_A]: ["legacy-bare-id"] }, launches: [] }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const { state } = migrateSessionSlots(parsed.state, fixedDeps());
    const agents = Object.values(state.agents);
    expect(agents).toHaveLength(1);
    // A legacy bare string means durableSessionId === liveSessionId === that string — preserved byte-for-byte through both the legacy normalizer AND the migration.
    expect(agents[0]?.durableSessionId).toBe("legacy-bare-id");
    expect(agents[0]?.liveSessionId).toBe("legacy-bare-id");
    expect(agents[0]?.state).toBe("on");
  });

  test("v1 with restoreAttemptCounts absent entirely", () => {
    const parsed = parseSessionSlotsState(JSON.stringify({ version: 1, onByKey: { [KEY_A]: [{ durableSessionId: "d1", liveSessionId: "l1" }] }, launches: [] }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.state.restoreAttemptCounts).toEqual({});

    const { state } = migrateSessionSlots(parsed.state, fixedDeps());
    expect(Object.values(state.agents)).toHaveLength(1);
    expect(state.restoreAttemptCounts).toEqual({});
  });

  test("multiple slots in the SAME directory become multiple distinct agents, each with its own minted id", () => {
    let slots = emptySessionSlots();
    slots = beginLaunch(slots, KEY_A, undefined, "attempt-1", 1000);
    slots = markLaunchStarted(slots, "attempt-1", "short-1");
    slots = resolveLaunch(slots, "short-1", "session-1");
    slots = beginLaunch(slots, KEY_A, undefined, "attempt-2", 1000);
    slots = markLaunchStarted(slots, "attempt-2", "short-2");
    slots = resolveLaunch(slots, "short-2", "session-2");

    const { state, summary } = migrateSessionSlots(slots, fixedDeps());
    const agents = Object.values(state.agents);
    expect(agents).toHaveLength(2);
    expect(new Set(agents.map((a) => a.id)).size).toBe(2); // distinct ids
    expect(new Set(agents.map((a) => a.durableSessionId))).toEqual(new Set(["session-1", "session-2"]));
    expect(summary.agentsCreated).toBe(2);
  });

  test("multiple directories are all represented in the summary", () => {
    let slots = emptySessionSlots();
    slots = beginLaunch(slots, KEY_A, undefined, "a1", 1000);
    slots = markLaunchStarted(slots, "a1", "s1");
    slots = resolveLaunch(slots, "s1", "sess-a");
    slots = beginLaunch(slots, KEY_B, undefined, "a2", 1000);
    slots = markLaunchStarted(slots, "a2", "s2");
    slots = resolveLaunch(slots, "s2", "sess-b");

    const { summary } = migrateSessionSlots(slots, fixedDeps());
    expect([...summary.directories].sort()).toEqual([KEY_A, KEY_B].sort());
  });

  test("an empty session-slots store migrates to an empty agent store, without error", () => {
    const { state, summary } = migrateSessionSlots(emptySessionSlots(), fixedDeps());
    expect(Object.values(state.agents)).toHaveLength(0);
    expect(summary.agentsCreated).toBe(0);
    expect(summary.directories).toEqual([]);
  });
});

describe("R-C.1: restoreAttemptCounts is TRANSLATED through the durableSessionId->agentId correspondence, not carried forward under its old key", () => {
  test("a count matching a migrated slot's durable session id lands under that agent's NEW id", () => {
    let slots = emptySessionSlots();
    slots = beginLaunch(slots, KEY_A, undefined, "a1", 1000);
    slots = markLaunchStarted(slots, "a1", "s1");
    slots = resolveLaunch(slots, "s1", "durable-x");
    slots = { ...slots, restoreAttemptCounts: { "durable-x": 2 } };

    const { state, summary } = migrateSessionSlots(slots, fixedDeps());
    const agent = Object.values(state.agents)[0];
    expect(agent).toBeDefined();
    // Translated — the cost R-C.1 makes zero: a lookup by the agent's OWN new id finds the real count.
    expect(state.restoreAttemptCounts[agent!.id]).toBe(2);
    expect(state.restoreAttemptCounts["durable-x"]).toBeUndefined(); // the OLD key is gone, not merely shadowed
    expect(summary.danglingRetryCountsDropped).toBe(0);
  });

  test("a count matching NO migrated slot (a pre-BAKR-13 directory-keyed leftover, or any stale key) is DROPPED and counted, never carried forward under a key that can never match again", () => {
    let slots = emptySessionSlots();
    slots = { ...slots, restoreAttemptCounts: { "/some/stale/directory-key": 5 } };

    const { state, summary } = migrateSessionSlots(slots, fixedDeps());
    expect(state.restoreAttemptCounts).toEqual({});
    expect(summary.danglingRetryCountsDropped).toBe(1);
  });
});

describe("R-C.2/R-C.3: a v1 launch record is split by its OWN state, not treated uniformly", () => {
  test("CASE 2 (error set): a RESTORE launch in flight at migration time, given up on, is attributed to the agent whose durableSessionId matches its priorSessionId — and KEEPS blocking (R-C.2)", () => {
    let slots = emptySessionSlots();
    slots = beginLaunch(slots, KEY_A, undefined, "seed", 1000);
    slots = markLaunchStarted(slots, "seed", "seed-short");
    slots = resolveLaunch(slots, "seed-short", "durable-1");
    slots = beginLaunch(slots, KEY_A, "durable-1", "given-up-attempt", 2000);
    slots = markLaunchFailed(slots, "given-up-attempt", "gave up after 3 consecutive restore attempts — pre-migration");

    const { state, summary } = migrateSessionSlots(slots, fixedDeps());
    expect(summary.unattachedLaunchesDropped).toBe(0);
    expect(state.launches).toHaveLength(1);
    const launch = state.launches[0];
    expect(launch?.error).toBe("gave up after 3 consecutive restore attempts — pre-migration");
    const agent = Object.values(state.agents).find((a) => a.durableSessionId === "durable-1");
    expect(agent).toBeDefined();
    expect(launch?.agentId).toBe(agent!.id);
  });

  test("CASE 2 defensive: an errored record whose priorSessionId matches NO migrated slot is dropped and counted, never attached by directory", () => {
    let slots = emptySessionSlots();
    slots = beginLaunch(slots, KEY_A, "no-such-durable-id", "orphan-attempt", 1000);
    slots = markLaunchFailed(slots, "orphan-attempt", "some pre-migration failure");

    const { state, summary } = migrateSessionSlots(slots, fixedDeps());
    expect(state.launches).toEqual([]);
    expect(summary.unattachedLaunchesDropped).toBe(1);
  });

  test("CASE 1 (wedged: no launchShortId, no error) with a matching priorSessionId is carried forward attached, UNCHANGED — the daemon's own promoteWedgedLaunches (not this function) is what promotes it", () => {
    let slots = emptySessionSlots();
    slots = beginLaunch(slots, KEY_A, undefined, "seed", 1000);
    slots = markLaunchStarted(slots, "seed", "seed-short");
    slots = resolveLaunch(slots, "seed-short", "durable-1");
    slots = beginLaunch(slots, KEY_A, "durable-1", "wedged-attempt", 2000); // no markLaunchStarted, no markLaunchFailed — genuinely wedged

    const { state, summary } = migrateSessionSlots(slots, fixedDeps());
    expect(summary.unattachedLaunchesDropped).toBe(0);
    expect(state.launches).toHaveLength(1);
    expect(state.launches[0]?.launchShortId).toBeUndefined();
    expect(state.launches[0]?.error).toBeUndefined();
  });

  test("CASE 1 (wedged) with NO priorSessionId at all has nothing to ever attach to (no shortId to match a future listing, no slot) — dropped and counted", () => {
    let slots = emptySessionSlots();
    slots = beginLaunch(slots, KEY_A, undefined, "wedged-fresh", 1000); // no priorSessionId, no shortId, no error

    const { state, summary } = migrateSessionSlots(slots, fixedDeps());
    expect(state.launches).toEqual([]);
    expect(summary.unattachedLaunchesDropped).toBe(1);
  });

  test("CASE 3, restore (launchShortId set, no error, priorSessionId defined): an ordinary pending restore, attached exactly like case 2", () => {
    let slots = emptySessionSlots();
    slots = beginLaunch(slots, KEY_A, undefined, "seed", 1000);
    slots = markLaunchStarted(slots, "seed", "seed-short");
    slots = resolveLaunch(slots, "seed-short", "durable-1");
    slots = beginLaunch(slots, KEY_A, "durable-1", "pending-restore", 2000);
    slots = markLaunchStarted(slots, "pending-restore", "pending-restore-short");

    const { state, summary } = migrateSessionSlots(slots, fixedDeps());
    expect(summary.pendingCreationsCarriedForward).toBe(0);
    expect(state.pendingCreations).toEqual([]);
    expect(state.launches).toHaveLength(1);
    expect(state.launches[0]?.launchShortId).toBe("pending-restore-short");
  });

  test("CASE 3, FRESH (launchShortId set, no error, NO priorSessionId): the reversed rule (R-C.3) — carried forward as a pendingCreation, NEVER marked unresolved, NEVER attached to an existing agent", () => {
    let slots = emptySessionSlots();
    slots = beginLaunch(slots, KEY_A, undefined, "in-flight-fresh", 1000);
    slots = markLaunchStarted(slots, "in-flight-fresh", "fresh-short");
    // Deliberately NOT resolved — this launch has no onByKey slot yet.

    const { state, summary } = migrateSessionSlots(slots, fixedDeps());
    expect(summary.pendingCreationsCarriedForward).toBe(1);
    expect(summary.unattachedLaunchesDropped).toBe(0);
    expect(state.launches).toEqual([]); // NOT in launches — not treated as an ordinary launch record
    expect(state.pendingCreations).toHaveLength(1);
    const pending = state.pendingCreations[0];
    expect(pending?.key).toBe(KEY_A); // the record's OWN launch target
    expect(pending?.launchShortId).toBe("fresh-short");
    // No agent was fabricated for it — that only happens on resolution (see agent-model.test.ts's resolvePendingCreation tests).
    expect(Object.values(state.agents).some((a) => a.durableSessionId === undefined && a.directory === KEY_A)).toBe(false);
  });

  test("a permanently-unresolved (errored) FRESH launch (no priorSessionId) is dropped and counted — R-C.3 only reverses the PENDING (case 3) sub-case, not case 2", () => {
    let slots = emptySessionSlots();
    slots = beginLaunch(slots, KEY_A, undefined, "a1", 1000);
    slots = markLaunchFailed(slots, "a1", "launch exited 1: boom");

    const { state, summary } = migrateSessionSlots(slots, fixedDeps());
    expect(state.launches).toEqual([]);
    expect(state.pendingCreations).toEqual([]);
    expect(summary.unattachedLaunchesDropped).toBe(1);
  });
});

describe("PROBE CONTROL: a broken migration that drops slots would fail the very first test in this file", () => {
  test("sanity: a session-slots store with N slots really does produce N agents, not zero and not N+1 (guards against a probe that can't observe either failure direction)", () => {
    let slots = emptySessionSlots();
    for (let i = 0; i < 5; i++) {
      slots = beginLaunch(slots, KEY_A, undefined, `attempt-${i}`, 1000);
      slots = markLaunchStarted(slots, `attempt-${i}`, `short-${i}`);
      slots = resolveLaunch(slots, `short-${i}`, `session-${i}`);
    }
    const { state } = migrateSessionSlots(slots, fixedDeps());
    expect(Object.values(state.agents)).toHaveLength(5);
  });
});
