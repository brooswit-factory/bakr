import { describe, expect, test } from "bun:test";
import { claimsPath, resolveStateHome } from "../../src/xdg";

describe("resolveStateHome", () => {
  test("uses XDG_STATE_HOME when set", () => {
    expect(resolveStateHome({ home: "/home/alice", stateHome: "/custom/state" })).toBe("/custom/state");
  });

  test("falls back to ~/.local/state when XDG_STATE_HOME is unset", () => {
    expect(resolveStateHome({ home: "/home/alice", stateHome: undefined })).toBe("/home/alice/.local/state");
  });

  test("falls back to ~/.local/state when XDG_STATE_HOME is the empty string, per the XDG spec treating empty as unset", () => {
    expect(resolveStateHome({ home: "/home/alice", stateHome: "" })).toBe("/home/alice/.local/state");
  });
});

describe("claimsPath", () => {
  test("is bakr/claims.json under the resolved state home", () => {
    expect(claimsPath({ home: "/home/alice", stateHome: undefined })).toBe("/home/alice/.local/state/bakr/claims.json");
  });

  test("respects a custom XDG_STATE_HOME", () => {
    expect(claimsPath({ home: "/home/alice", stateHome: "/custom/state" })).toBe("/custom/state/bakr/claims.json");
  });

  test("tolerates a trailing slash on XDG_STATE_HOME", () => {
    expect(claimsPath({ home: "/home/alice", stateHome: "/custom/state/" })).toBe("/custom/state/bakr/claims.json");
  });
});
