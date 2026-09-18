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
    // Hosted by drovr (BAKR-37): the workspace carries drovr's label for this agent, `drovr bakr-<id>`.
    expect(host.calls.find((c) => c[1] === "workspace" && c[2] === "create")).toEqual(["herdr", "workspace", "create", "--cwd", DIR, "--label", "drovr bakr-rocketr", "--no-focus"]);
    expect(host.panes[0]!.name).toBe("bakr-rocketr");
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
    expect([a.ok, b.ok]).toEqual([true, true]);
    const names = host.panes.map((p) => p.name);
    expect(new Set(names).size).toBe(2);
    for (const name of names) expect(name).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
  });

  // Ported (BAKR-37): bakr's own host suffixed each name with the workspace id so a second pane of the SAME agent
  // could start beside a stale one. drovr's label is the agent's own, and it refuses a second pane under a name a
  // live pane holds, before creating anything: two panes can no longer run one agent.
  test("a second pane for an agent whose pane is still open is refused, naming the pane that holds it, and nothing is created", async () => {
    const host = makeFakeHost();
    const a = await launch("/d/a", [], { runCommand: host.runCommand, label: "@n0y45b5r4f2ydey7nc", ...instant() });
    const again = await launch("/d/c", [], { runCommand: host.runCommand, label: "@n0y45b5r4f2ydey7nc", ...instant() });
    expect(again.ok).toBe(false);
    if (!again.ok && a.ok) expect(again.error).toBe(`label-taken: pane ${a.id} already holds the herdr agent name bakr-n0y45b5r4f2ydey7nc`);
    expect(host.panes).toHaveLength(1);
    expect(host.calls.filter((c) => c[1] === "workspace" && c[2] === "create")).toHaveLength(1);
  });

  test("a fresh workspace whose shell is not ready yet is started once it is, not abandoned", async () => {
    const host = makeFakeHost({ shellNotReadyTimes: 2 });
    const r = await launch(DIR, [], { runCommand: host.runCommand, label: "@a", ...instant() });
    expect(r.ok).toBe(true);
    expect(host.calls.filter((c) => c[1] === "agent" && c[2] === "start")).toHaveLength(3);
    expect(host.stops()).toEqual([]);
  });

  // Ported (BAKR-37): drovr's startManagedAgent gives up with its own shell-readiness error (attempts, elapsed,
  // the pane's processes), not herdr's last refusal text.
  test("a shell that never becomes ready gives up and closes the workspace", async () => {
    const host = makeFakeHost({ shellNotReadyTimes: 1_000 });
    const r = await launch(DIR, [], { runCommand: host.runCommand, label: "@a", ...instant() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Agent shell readiness expired");
    expect(host.panes).toEqual([]);
  });
});
