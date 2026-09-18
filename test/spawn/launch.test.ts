import { describe, expect, test } from "bun:test";
import { launch } from "../../src/spawn/launch";
import { makeFakeHost } from "../support/fake-host";

const DIR = "/home/op/code/rocketr";
const instant = () => {
  let clock = 0;
  return { sleep: async (ms: number) => { clock += ms; }, now: () => clock };
};

describe("launch (herdr)", () => {
  test("starts claude interactively in a new workspace pane in the directory, never `claude --bg`", async () => {
    const host = makeFakeHost();
    const r = await launch(DIR, ["--mcp-config", `${DIR}/.mcp.json`], { runCommand: host.runCommand, label: "@rocketr", mintSessionId: () => "fixed-session", ...instant() });
    expect(r).toEqual({ ok: true, id: "w1:p1", sessionId: "fixed-session" });
    expect(host.calls[0]).toEqual(["herdr", "workspace", "create", "--cwd", DIR, "--label", "bakr @rocketr", "--no-focus"]);
    // FALSIFIER: a fresh launch names its own session, so its id is known before claude prints anything.
    expect(host.starts()).toEqual([["--session-id", "fixed-session", "--mcp-config", `${DIR}/.mcp.json`]]);
    expect(host.calls.some((c) => c.includes("--bg") || c[0] === "systemd-run")).toBe(false);
  });

  test("a resume keeps the session id it names and adds no --session-id", async () => {
    const host = makeFakeHost();
    const r = await launch(DIR, ["--resume", "abc-session"], { runCommand: host.runCommand, ...instant() });
    expect(r.ok && r.sessionId).toBe("abc-session");
    expect(host.starts()).toEqual([["--resume", "abc-session"]]);
  });

  test("a start that fails closes its workspace, leaving no half-started pane", async () => {
    const host = makeFakeHost({ failStart: "no claude on PATH" });
    const r = await launch(DIR, [], { runCommand: host.runCommand, ...instant() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("no claude on PATH");
    expect(host.stops()).toEqual(["w1"]);
    expect(host.panes).toEqual([]);
  });

  test("an unknown blocking prompt is reported with its screen, never guessed at, and the workspace is closed", async () => {
    const host = makeFakeHost({ blockedScreen: "Some new question?\n❯ 1. Yes\n  2. No\nEnter to confirm · Esc to cancel" });
    const r = await launch(DIR, [], { runCommand: host.runCommand, ...instant() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Some new question?");
    expect(host.calls.some((c) => c[2] === "send-keys")).toBe(false);
    expect(host.panes).toEqual([]);
  });

  test("a start herdr cannot even create a workspace for fails without starting anything", async () => {
    const r = await launch(DIR, [], {
      runCommand: async () => ({ exitCode: 1, stdout: JSON.stringify({ error: { code: "server_unavailable", message: "herdr server is not running" } }), stderr: "" }),
      ...instant(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("herdr server is not running");
  });
});
