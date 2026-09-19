// BAKR-61: the pure argv verdict. Each test names the live argv it stands for;
// the first is the one measured on the laptop after the 2026-09-19 reboot.

import { describe, expect, test } from "bun:test";
import { checkAgentArgv } from "../../src/argv-check";

const SESSION = "2cbb5dc5-3f77-487d-b04c-a4c4c046b13e";
const EXPECTED = [
  "--mcp-config", "/home/u/code/minecraft/.mcp.json",
  "--settings", '{"enabledMcpjsonServers":["atlassian","yappr","rocketr"]}',
  "--dangerously-load-development-channels=server:atlassian",
  "--dangerously-load-development-channels=server:yappr",
  "--dangerously-load-development-channels=server:rocketr",
];
const HEALTHY = ["claude", "--resume", SESSION, ...EXPECTED];

describe("checkAgentArgv", () => {
  test("a bare `claude --resume <id>` (herdr's restore after a reboot) is a mismatch: every channel and the approval are missing", () => {
    const verdict = checkAgentArgv(EXPECTED, ["claude", "--resume", SESSION], SESSION);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain("--dangerously-load-development-channels server:atlassian server:yappr server:rocketr");
    expect(verdict.reason).toContain("--mcp-config");
    expect(verdict.reason).toContain("argv lacks --settings");
  });

  test("the argv bakr launches with is healthy", () => {
    expect(checkAgentArgv(EXPECTED, HEALTHY, SESSION)).toEqual({ ok: true });
  });

  test("a fresh launch names its session with --session-id, and that is healthy too", () => {
    expect(checkAgentArgv(EXPECTED, ["claude", "--session-id", SESSION, ...EXPECTED], SESSION)).toEqual({ ok: true });
  });

  test("one missing channel is a mismatch naming just that channel", () => {
    const observed = HEALTHY.filter((a) => a !== "--dangerously-load-development-channels=server:yappr");
    expect(checkAgentArgv(EXPECTED, observed, SESSION)).toEqual({ ok: false, reason: "argv lacks --dangerously-load-development-channels server:yappr" });
  });

  test("missing --settings is a mismatch", () => {
    const at = HEALTHY.indexOf("--settings");
    const observed = [...HEALTHY.slice(0, at), ...HEALTHY.slice(at + 2)];
    expect(checkAgentArgv(EXPECTED, observed, SESSION)).toMatchObject({ ok: false, reason: expect.stringContaining("argv lacks --settings") });
  });

  test("--settings is compared parsed: the same servers in another order, with other whitespace, match", () => {
    const observed = HEALTHY.map((a) => a.startsWith("{") ? '{ "enabledMcpjsonServers": [ "rocketr", "atlassian", "yappr" ] }' : a);
    expect(checkAgentArgv(EXPECTED, observed, SESSION)).toEqual({ ok: true });
  });

  test("--settings approving different servers is a mismatch", () => {
    const observed = HEALTHY.map((a) => a.startsWith("{") ? '{"enabledMcpjsonServers":["rocketr"]}' : a);
    expect(checkAgentArgv(EXPECTED, observed, SESSION)).toMatchObject({ ok: false, reason: expect.stringContaining('--settings approves ["rocketr"]') });
  });

  test("a different session id is a mismatch", () => {
    const observed = HEALTHY.map((a) => a === SESSION ? "someone-elses-session" : a);
    expect(checkAgentArgv(EXPECTED, observed, SESSION)).toEqual({ ok: false, reason: `runs session someone-elses-session, not ${SESSION}` });
  });

  test("a fork states no session of its own, so the session is not compared", () => {
    expect(checkAgentArgv(EXPECTED, ["claude", "--resume", "the-parent", "--fork-session", ...EXPECTED], SESSION)).toEqual({ ok: true });
  });

  test.each([
    [["--permission-mode", "bypassPermissions"]],
    [["--permission-mode=bypassPermissions"]],
    [["--dangerously-skip-permissions"]],
    [["--allow-dangerously-skip-permissions"]],
  ])("a permission bypass (%p) is a mismatch even though drovr's check skips the permission mode", (bypass) => {
    expect(checkAgentArgv(EXPECTED, [...HEALTHY, ...bypass], SESSION)).toMatchObject({ ok: false, reason: expect.stringContaining("no permission bypass") });
  });

  test("an agent with no MCP at all expects no flags, so a bare resume of its own session is healthy", () => {
    expect(checkAgentArgv([], ["claude", "--resume", SESSION], SESSION)).toEqual({ ok: true });
  });
});
