// BAKR-37: bakr's agents hosted through drovr's hostResident / listResidents /
// stopResident, with the panes bakr started before that adopted, never restarted.

import { describe, expect, test } from "bun:test";
import { buildProviderLaunchArgs } from "@brooswit/drovr";
import { launch } from "../../src/spawn/launch";
import { listBackgroundSessions } from "../../src/spawn/list";
import { stopSession } from "../../src/spawn/stop";
import { respawnSession } from "../../src/spawn/respawn";
import { residentLabelFor, residentLaunchFrom, withoutPermissionMode } from "../../src/spawn/herdr";
import { makeFakeHost } from "../support/fake-host";

const DIR = "/home/op/code/rocketr";
const instant = () => {
  let clock = 0;
  return { sleep: async (ms: number) => { clock += ms; }, now: () => clock };
};

describe("adopting the panes bakr started before drovr hosted them", () => {
  // A live pane as bakr's own host left it: workspace `bakr <id>`, agent name `bakr-<id>-<ws>`.
  const legacyPane = (host: ReturnType<typeof makeFakeHost>, sessionId: string, pid = 4242) =>
    host.addPane({ cwd: DIR, sessionId, pid, label: "bakr @n0y45b5r4f2ydey7nc", name: "bakr-n0y45b5r4f2ydey7nc-w1" });

  test("the listing still finds it by session id, with its pid, beside a drovr resident", async () => {
    const host = makeFakeHost();
    const old = legacyPane(host, "old-session");
    const fresh = await launch(DIR, [], { runCommand: host.runCommand, label: "@tmbqd7bkew6d3xf6p4", mintSessionId: () => "new-session", ...instant() });
    expect(fresh.ok).toBe(true);
    const sessions = await listBackgroundSessions({ runCommand: host.runCommand });
    expect(sessions.find((s) => s.sessionId === "old-session")).toEqual({ id: old.paneId, sessionId: "old-session", cwd: DIR, startedAt: 0, pid: 4242, state: "idle" });
    expect(sessions.find((s) => s.sessionId === "new-session")).toEqual({ id: fresh.ok ? fresh.id : "", sessionId: "new-session", cwd: DIR, startedAt: 0, pid: process.pid, state: "idle" });
    expect(sessions).toHaveLength(2);
  });

  test("listing it restarts nothing: no workspace is created or closed, no agent started", async () => {
    const host = makeFakeHost();
    legacyPane(host, "old-session");
    await listBackgroundSessions({ runCommand: host.runCommand });
    expect(host.calls.filter((c) => c[0] === "herdr" && !(c[2] === "list" || c[2] === "process-info"))).toEqual([]);
  });

  test("off / relaunch still close it: its own workspace, and nothing else", async () => {
    const host = makeFakeHost();
    const old = legacyPane(host, "old-session");
    const other = legacyPane(host, "other-session");
    expect(await stopSession(old.paneId, { runCommand: host.runCommand })).toEqual({ ok: true });
    expect(host.stops()).toEqual([old.workspaceId]);
    expect(host.panes.map((p) => p.paneId)).toEqual([other.paneId]);
  });

  test("a relaunch moves the agent onto drovr's host: the same session resumed in a new pane, exactly one pane for it", async () => {
    const host = makeFakeHost();
    const old = legacyPane(host, "s1");
    expect(await stopSession(old.paneId, { runCommand: host.runCommand })).toEqual({ ok: true });
    const r = await respawnSession({ sessionId: "s1", directory: DIR, args: [] }, { runCommand: host.runCommand, label: "@n0y45b5r4f2ydey7nc", ...instant() });
    expect(r.ok).toBe(true);
    expect(host.panes.filter((p) => p.sessionId === "s1")).toHaveLength(1);
    expect(host.panes[0]!.label).toBe("drovr bakr-n0y45b5r4f2ydey7nc");
  });

  test("a session running in a pane nobody here started is still listed alive — the double-restore guard stays until DROVR-13", async () => {
    const host = makeFakeHost();
    host.addPane({ cwd: DIR, sessionId: "s1", label: "someone's own workspace" });
    const sessions = await listBackgroundSessions({ runCommand: host.runCommand });
    expect(sessions.map((s) => s.sessionId)).toEqual(["s1"]);
  });
});

describe("drovr's residents", () => {
  test("a drovr resident is stopped through stopResident: its workspace closed, the listing empty after", async () => {
    const host = makeFakeHost();
    const r = await launch(DIR, [], { runCommand: host.runCommand, label: "@a", ...instant() });
    if (!r.ok) throw new Error(r.error);
    expect(await stopSession(r.id, { runCommand: host.runCommand })).toEqual({ ok: true });
    expect(host.stops()).toEqual([r.id.slice(0, r.id.indexOf(":"))]);
    expect(await listBackgroundSessions({ runCommand: host.runCommand })).toEqual([]);
  });

  test("a stop drovr's close refuses is a stop failure with drovr's reason", async () => {
    const host = makeFakeHost();
    const r = await launch(DIR, [], { runCommand: host.runCommand, label: "@a", ...instant() });
    if (!r.ok) throw new Error(r.error);
    const failing = makeFakeHost({ failStop: true });
    failing.panes.push(...host.panes);
    const stopped = await stopSession(r.id, { runCommand: failing.runCommand });
    expect(stopped.ok).toBe(false);
    if (!stopped.ok) expect(stopped.error).toContain("close-failed");
  });

  test("a fork is started by bakr's own host, which drovr's request cannot express", async () => {
    const host = makeFakeHost();
    const r = await launch(DIR, ["--resume", "s1", "--fork-session"], { runCommand: host.runCommand, label: "@a", ...instant() });
    expect(r.ok).toBe(true);
    expect(host.panes[0]!.label).toBe("bakr @a");
    expect(host.starts()).toEqual([["--resume", "s1", "--fork-session"]]);
  });

  test("an argument drovr cannot carry fails the launch before anything is created", async () => {
    const host = makeFakeHost();
    const r = await launch(DIR, ["--verbose"], { runCommand: host.runCommand, label: "@a", ...instant() });
    expect(r).toEqual({ ok: false, error: "drovr's hostResident cannot carry the claude argument --verbose" });
    expect(host.calls).toEqual([]);
  });
});

describe("reading bakr's launch flags back into drovr's request", () => {
  test("exactly what launch-config.ts builds reads back, and rebuilds to the same argv", () => {
    const inputs = { mcpConfigPath: `${DIR}/.mcp.json`, mcpServersApproved: ["yappr", "rocketr"], mcpNotificationServers: ["yappr", "rocketr"] };
    const flags = buildProviderLaunchArgs("claude", inputs);
    const read = residentLaunchFrom(["--resume", "s1", ...flags]);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.resume).toBe("s1");
      expect(buildProviderLaunchArgs("claude", read.inputs)).toEqual(flags);
    }
  });

  test("a fresh launch's own --session-id is kept, and nothing is asked of drovr for it", () => {
    expect(residentLaunchFrom(["--session-id", "given"])).toEqual({ ok: true, inputs: {}, sessionId: "given" });
  });

  test.each([
    [["--settings", JSON.stringify({ enabledMcpjsonServers: ["a"], permissions: {} })], /only an enabledMcpjsonServers approval/],
    [["--resume", "s1", "--session-id", "s2"], /cannot both/],
    [["--mcp-config"], /has no value/],
    [["--dangerously-skip-permissions"], /cannot carry the claude argument --dangerously-skip-permissions/],
  ] as const)("%p is refused, never dropped", (args, why) => {
    const read = residentLaunchFrom(args);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error).toMatch(why);
  });

  test("the drovr label is the agent's id without its @, within herdr's name rule", () => {
    expect(residentLabelFor("@n0y45b5r4f2ydey7nc")).toBe("bakr-n0y45b5r4f2ydey7nc");
    expect(residentLabelFor("agent")).toBe("bakr-agent");
    expect(residentLabelFor("@")).toBe("bakr-agent");
    expect(residentLabelFor("@n0y45b5r4f2ydey7nc")).toMatch(/^[a-z0-9_-]{1,32}$/);
  });
});

describe("the permission mode drovr adds (interim, open decision on BAKR-37)", () => {
  test("a hosted start carries no permission mode, as bakr's starts never have", async () => {
    const host = makeFakeHost();
    await launch(DIR, [], { runCommand: host.runCommand, label: "@a", mintSessionId: () => "s", ...instant() });
    expect(host.starts()).toEqual([["--session-id", "s"]]);
  });

  test("only drovr's own bypassPermissions pair is removed", () => {
    expect(withoutPermissionMode(["--session-id", "s", "--permission-mode", "bypassPermissions", "--mcp-config", "m"])).toEqual(["--session-id", "s", "--mcp-config", "m"]);
    expect(withoutPermissionMode(["--permission-mode", "plan"])).toEqual(["--permission-mode", "plan"]);
  });
});
