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

  // The 2026-09-18 incident: every pane was started under the fixed herdr agent name "claude", so while one bakr
  // pane was open every other start was refused ("agent name claude is already used") — after its predecessor had
  // been stopped. The fake enforces herdr's own name rules, so this fails on the old fixed name.
  test("several agents run side by side, each pane under its own valid herdr agent name", async () => {
    const host = makeFakeHost();
    const a = await launch("/d/a", [], { runCommand: host.runCommand, label: "@n0y45b5r4f2ydey7nc", ...instant() });
    const b = await launch("/d/b", [], { runCommand: host.runCommand, label: "@tmbqd7bkew6d3xf6p4", ...instant() });
    const c = await launch("/d/c", [], { runCommand: host.runCommand, label: "@n0y45b5r4f2ydey7nc", ...instant() });
    expect([a.ok, b.ok, c.ok]).toEqual([true, true, true]);
    const names = host.panes.map((p) => p.name);
    expect(new Set(names).size).toBe(3);
    for (const name of names) expect(name).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
  });

  test("a fresh workspace whose shell is not ready yet is started once it is, not abandoned", async () => {
    const host = makeFakeHost({ shellNotReadyTimes: 2 });
    const r = await launch(DIR, [], { runCommand: host.runCommand, label: "@a", ...instant() });
    expect(r.ok).toBe(true);
    expect(host.calls.filter((c) => c[1] === "agent" && c[2] === "start")).toHaveLength(3);
    expect(host.stops()).toEqual([]);
  });

  test("a shell that never becomes ready gives up with herdr's reason and closes the workspace", async () => {
    const host = makeFakeHost({ shellNotReadyTimes: 1_000 });
    const r = await launch(DIR, [], { runCommand: host.runCommand, label: "@a", ...instant() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("not an available shell");
    expect(host.panes).toEqual([]);
  });
});
