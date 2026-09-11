import { describe, expect, test } from "bun:test";
import {
  claim,
  emptyStore,
  list,
  lookup,
  parseClaimStoreState,
  release,
  serializeClaimStoreState,
  type ClaimStoreState,
} from "../../src/claim-model";
import type { ClaimKey } from "../../src/claim-key-resolve";

const KEY_A = "/home/alice/project" as ClaimKey;
const KEY_B = "/home/alice/other" as ClaimKey;

describe("claim", () => {
  test("claiming a fresh key creates a claim with the given timestamp", () => {
    const { state, claim: c } = claim(emptyStore(), KEY_A, 1000);
    expect(c).toEqual({ key: KEY_A, claimedAt: 1000 });
    expect(lookup(state, KEY_A)).toEqual(c);
  });

  test("is total and idempotent: claiming an already-claimed key returns the EXISTING claim, not a re-stamped one", () => {
    const first = claim(emptyStore(), KEY_A, 1000);
    const second = claim(first.state, KEY_A, 999999);
    expect(second.claim).toEqual(first.claim);
    expect(second.claim.claimedAt).toBe(1000);
    expect(second.state).toBe(first.state);
  });

  test("there is no error path for claiming twice — the return type has no error variant", () => {
    const first = claim(emptyStore(), KEY_A, 1000);
    // If this compiled and ran, `claim` never threw and never returned anything but a ClaimOutcome.
    expect(() => claim(first.state, KEY_A, 2000)).not.toThrow();
  });
});

describe("lookup", () => {
  test("returns undefined for a key with no claim", () => {
    expect(lookup(emptyStore(), KEY_A)).toBeUndefined();
  });
});

describe("list", () => {
  test("returns every claim in the store", () => {
    const { state: s1 } = claim(emptyStore(), KEY_A, 1);
    const { state: s2 } = claim(s1, KEY_B, 2);
    const all = list(s2);
    expect(all).toHaveLength(2);
    expect(all.map((c) => c.key).sort()).toEqual([KEY_A, KEY_B].sort());
  });

  test("an empty store lists nothing", () => {
    expect(list(emptyStore())).toEqual([]);
  });
});

describe("release", () => {
  test("removes an existing claim", () => {
    const { state } = claim(emptyStore(), KEY_A, 1);
    const released = release(state, KEY_A);
    expect(lookup(released, KEY_A)).toBeUndefined();
  });

  test("is total and idempotent: releasing an unclaimed key returns the state unchanged rather than erroring", () => {
    const state = emptyStore();
    const released = release(state, KEY_A);
    expect(released).toEqual(state);
    expect(() => release(state, KEY_A)).not.toThrow();
  });

  test("releasing one claim leaves other claims intact", () => {
    const { state: s1 } = claim(emptyStore(), KEY_A, 1);
    const { state: s2 } = claim(s1, KEY_B, 2);
    const released = release(s2, KEY_A);
    expect(lookup(released, KEY_A)).toBeUndefined();
    expect(lookup(released, KEY_B)).toBeDefined();
  });
});

describe("wire format round-trip", () => {
  function expectRoundTrips(state: ClaimStoreState): void {
    const parsed = parseClaimStoreState(serializeClaimStoreState(state));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.state).toEqual(state);
    }
  }

  test("an empty store round-trips", () => {
    expectRoundTrips(emptyStore());
  });

  test("a store with claims round-trips", () => {
    const { state: s1 } = claim(emptyStore(), KEY_A, 1000);
    const { state: s2 } = claim(s1, KEY_B, 2000);
    expectRoundTrips(s2);
  });

  test("invalid JSON is reported as a typed error, never thrown", () => {
    const result = parseClaimStoreState("{not json");
    expect(result.ok).toBe(false);
  });

  test("valid JSON with the wrong shape is reported as a typed error", () => {
    const result = parseClaimStoreState(JSON.stringify({ hello: "world" }));
    expect(result.ok).toBe(false);
  });

  test("a wrong version number is reported as a typed error", () => {
    const result = parseClaimStoreState(JSON.stringify({ version: 2, claims: {} }));
    expect(result.ok).toBe(false);
  });

  test("a claim entry with the wrong shape is reported as a typed error", () => {
    const result = parseClaimStoreState(JSON.stringify({ version: 1, claims: { "/x": { claimedAt: "not-a-number", agentIds: [] } } }));
    expect(result.ok).toBe(false);
  });
});

describe("BAKR-16 R-D: agentIds is retired from the in-memory model, but the wire format stays compatible both ways", () => {
  test("a claim entry carrying agentIds (written by an older binary) still parses — the field is accepted and then dropped from the in-memory Claim", () => {
    const result = parseClaimStoreState(JSON.stringify({ version: 1, claims: { "/x": { claimedAt: 5, agentIds: ["some-id"] } } }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state.claims["/x"]).toEqual({ key: "/x" as ClaimKey, claimedAt: 5 });
    }
  });

  test("a claim entry with NO agentIds field at all also parses — absence has an obvious correct reading and must not trip the malformed path", () => {
    const result = parseClaimStoreState(JSON.stringify({ version: 1, claims: { "/x": { claimedAt: 5 } } }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state.claims["/x"]).toEqual({ key: "/x" as ClaimKey, claimedAt: 5 });
    }
  });

  test("serializeClaimStoreState always writes agentIds: [] on every claim, as a frozen compatibility field an older binary's parser still requires", () => {
    const { state } = claim(emptyStore(), KEY_A, 1000);
    const written = JSON.parse(serializeClaimStoreState(state));
    expect(written.claims[KEY_A].agentIds).toEqual([]);
  });

  test("a present-but-wrong agentIds is still rejected as malformed — this is a default for ABSENCE, not a loosened shape check", () => {
    const result = parseClaimStoreState(JSON.stringify({ version: 1, claims: { "/x": { claimedAt: 5, agentIds: "not-an-array" } } }));
    expect(result.ok).toBe(false);
  });
});
