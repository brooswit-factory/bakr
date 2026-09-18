import { describe, expect, test } from "bun:test";
import type { McpSettingsIo } from "@brooswit/drovr";
import {
  claudeLaunchArgs,
  formatMcpSpec,
  mcpConfigPathFor,
  parseMcpServerNames,
  parseMcpSpec,
  parseNotificationServers,
  provisionMcpFor,
  resolveMcpAccess,
  type LaunchConfigDeps,
  type McpServerDeclaration,
} from "../../src/launch-config";

const MINECRAFT_MCP = JSON.stringify({
  mcpServers: {
    atlassian: { type: "http", url: "https://mcp.atlassian.com/v2/mcp" },
    yappr: { type: "stdio", command: "/home/op/.bun/bin/bun", args: ["yappr", "mcp"] },
  },
});

const ROCKETR_MCP = JSON.stringify({
  mcpServers: {
    rocketr: { type: "http", url: "http://127.0.0.1:8790/mcp" },
    yappr: { type: "stdio", command: "/home/op/.bun/bin/bun", args: ["yappr", "mcp"] },
  },
});

/** An in-memory stand-in for the vendor settings files drovr reads and writes. */
function memorySettings(initial: Record<string, string> = {}): McpSettingsIo & { files: Record<string, string> } {
  const files = { ...initial };
  return {
    files,
    readSettings: async (path) => files[path],
    writeSettings: async (path, contents) => { files[path] = contents; },
  };
}

function deps(overrides: Partial<LaunchConfigDeps> & { files?: Record<string, string> } = {}): LaunchConfigDeps {
  const files = overrides.files ?? {};
  return {
    readConfigFile: overrides.readConfigFile ?? (async (path: string) => files[path]),
    notificationServers: overrides.notificationServers ?? ["yappr"],
    settingsIo: overrides.settingsIo ?? memorySettings(),
    ...(overrides.warn === undefined ? {} : { warn: overrides.warn }),
  };
}

const approvalIn = (io: { files: Record<string, string> }, dir: string): unknown => {
  const raw = io.files[`${dir}/.claude/settings.local.json`];
  return raw === undefined ? undefined : (JSON.parse(raw) as { enabledMcpjsonServers?: unknown }).enabledMcpjsonServers;
};

describe("an agent with no declaration of its own uses the host default", () => {
  test("a coordinator whose .mcp.json configures yappr launches subscribed to it, and approved for it", async () => {
    const io = memorySettings();
    const args = await claudeLaunchArgs("/home/op/code/brooswit", deps({
      settingsIo: io,
      files: { "/home/op/code/brooswit/.mcp.json": MINECRAFT_MCP },
    }));
    expect(args).toEqual([
      "--mcp-config", "/home/op/code/brooswit/.mcp.json",
      "--dangerously-load-development-channels", "server:yappr",
    ]);
    // FALSIFIER: without this the session sits `blocked` on an approval prompt.
    expect(approvalIn(io, "/home/op/code/brooswit")).toEqual(["yappr"]);
  });

  test("a host default server the directory never mentions leaves the launch untouched, and is reported", async () => {
    const io = memorySettings();
    const warnings: string[] = [];
    const args = await claudeLaunchArgs("/home/op/code/other", deps({
      settingsIo: io,
      warn: (m) => warnings.push(m),
      files: { "/home/op/code/other/.mcp.json": JSON.stringify({ mcpServers: { atlassian: {} } }) },
    }));
    expect(args).toEqual([]);
    expect(io.files).toEqual({});
    expect(warnings.join("\n")).toContain("yappr");
  });

  test("a host that configures nothing launches exactly as it did before, and reads and writes nothing", async () => {
    const read: string[] = [];
    const io = memorySettings();
    const args = await claudeLaunchArgs("/home/op/code/brooswit", deps({
      notificationServers: [],
      settingsIo: io,
      readConfigFile: async (path) => { read.push(path); return MINECRAFT_MCP; },
    }));
    expect(args).toEqual([]);
    expect(read).toEqual([]);
    expect(io.files).toEqual({});
  });

  test.each([
    ["absent", undefined],
    ["not JSON at all", "{ this is not json"],
    ["JSON of another shape", JSON.stringify([1, 2, 3])],
    ["JSON without mcpServers", JSON.stringify({ other: true })],
    ["an mcpServers that is not an object", JSON.stringify({ mcpServers: ["yappr"] })],
  ])("a .mcp.json that is %s carries nothing rather than failing the launch", async (_label, contents) => {
    expect(parseMcpServerNames(contents)).toEqual([]);
    const args = await claudeLaunchArgs("/home/op/code/brooswit", deps({ readConfigFile: async () => contents }));
    expect(args).toEqual([]);
  });

  test("the MCP configuration read is the one the session itself would read", () => {
    expect(mcpConfigPathFor("/home/op/code/brooswit")).toBe("/home/op/code/brooswit/.mcp.json");
  });

  test.each([
    [undefined, []],
    ["", []],
    ["   ", []],
    ["yappr", ["yappr"]],
    ["yappr,other", ["yappr", "other"]],
    ["yappr other", ["yappr", "other"]],
    ["yappr, other ", ["yappr", "other"]],
  ])("a configured host list of %p reads as %p", (raw, expected) => {
    expect(parseNotificationServers(raw as string | undefined)).toEqual(expected as string[]);
  });
});

describe("an agent's own declaration", () => {
  const DIR = "/home/op/code/rocketr";
  const files = { [`${DIR}/.mcp.json`]: ROCKETR_MCP };

  test("replaces the host default: its servers are approved, and only +notify ones subscribed", async () => {
    const io = memorySettings();
    const declared: McpServerDeclaration[] = [{ name: "rocketr", notifications: true }, { name: "yappr", notifications: false }];
    const args = await claudeLaunchArgs(DIR, deps({ notificationServers: ["yappr"], settingsIo: io, files }), declared);
    expect(args).toEqual([
      "--mcp-config", `${DIR}/.mcp.json`,
      "--dangerously-load-development-channels", "server:rocketr",
    ]);
    expect(approvalIn(io, DIR)).toEqual(["rocketr", "yappr"]);
  });

  test("the directory's MCP config is still passed when nothing is subscribed to", async () => {
    const args = await claudeLaunchArgs(DIR, deps({ files }), [{ name: "yappr", notifications: false }]);
    expect(args).toEqual(["--mcp-config", `${DIR}/.mcp.json`]);
  });

  test("an empty declaration is an agent with no MCP at all, not the host default", async () => {
    const io = memorySettings();
    expect(await claudeLaunchArgs(DIR, deps({ notificationServers: ["yappr"], settingsIo: io, files }), [])).toEqual([]);
    expect(io.files).toEqual({});
  });

  test("a declared server the directory's .mcp.json does not configure is dropped and reported", async () => {
    const access = await resolveMcpAccess(DIR, deps({ files }), [{ name: "rocketr", notifications: true }, { name: "absent", notifications: true }]);
    expect(access.servers).toEqual([{ name: "rocketr", notifications: true }]);
    expect(access.missing).toEqual(["absent"]);
  });

  test("approval keeps every other setting the file already holds", async () => {
    const path = `${DIR}/.claude/settings.local.json`;
    const io = memorySettings({ [path]: JSON.stringify({ permissions: { allow: ["Bash(ls)"] }, enabledMcpjsonServers: ["other"] }) });
    await provisionMcpFor(DIR, deps({ settingsIo: io, files }), [{ name: "rocketr", notifications: true }]);
    expect(JSON.parse(io.files[path]!)).toEqual({ permissions: { allow: ["Bash(ls)"] }, enabledMcpjsonServers: ["other", "rocketr"] });
  });

  test("a settings file drovr refuses to rewrite is reported, and the start still goes ahead", async () => {
    const path = `${DIR}/.claude/settings.local.json`;
    const io = memorySettings({ [path]: "{ not json" });
    const warnings: string[] = [];
    const args = await claudeLaunchArgs(DIR, deps({ settingsIo: io, files, warn: (m) => warnings.push(m) }), [{ name: "rocketr", notifications: true }]);
    expect(args).toContain("server:rocketr");
    expect(io.files[path]).toBe("{ not json");
    expect(warnings.join("\n")).toContain("could not write MCP approval");
  });

  test("provisioning alone, as a respawn needs, approves without spelling any flag", async () => {
    const io = memorySettings();
    await provisionMcpFor(DIR, deps({ settingsIo: io, files }), [{ name: "rocketr", notifications: true }]);
    expect(approvalIn(io, DIR)).toEqual(["rocketr"]);
  });
});

describe("server specs on the command line", () => {
  test.each([
    ["yappr", { name: "yappr", notifications: false }],
    ["yappr+notify", { name: "yappr", notifications: true }],
    ["my_server-2+notify", { name: "my_server-2", notifications: true }],
  ])("%p parses", (spec, expected) => {
    expect(parseMcpSpec(spec)).toEqual(expected);
    expect(formatMcpSpec(expected)).toBe(spec);
  });

  test.each(["", "+notify", "yappr+other", "a/b", "yappr notify", "../x"])("%p is refused", (spec) => {
    expect(typeof parseMcpSpec(spec)).toBe("string");
  });
});
