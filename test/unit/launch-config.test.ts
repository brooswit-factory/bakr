import { describe, expect, test } from "bun:test";
import type { McpSettingsIo } from "@brooswit/drovr";
import {
  claudeLaunchArgs,
  formatMcpSpec,
  mcpConfigPathFor,
  parseMcpServerNames,
  parentDirsOf,
  parseMcpSpec,
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
    settingsIo: overrides.settingsIo ?? memorySettings(),
    ...(overrides.warn === undefined ? {} : { warn: overrides.warn }),
  };
}

const approvalIn = (io: { files: Record<string, string> }, dir: string): unknown => {
  const raw = io.files[`${dir}/.claude/settings.local.json`];
  return raw === undefined ? undefined : (JSON.parse(raw) as { enabledMcpjsonServers?: unknown }).enabledMcpjsonServers;
};

describe("an agent with no declaration of its own: channels on for every server its .mcp.json configures", () => {
  test("every server is approved and subscribed, with no opt-in", async () => {
    const io = memorySettings();
    const args = await claudeLaunchArgs("/home/op/code/brooswit", deps({
      settingsIo: io,
      files: { "/home/op/code/brooswit/.mcp.json": MINECRAFT_MCP },
    }));
    expect(args).toEqual([
      "--mcp-config", "/home/op/code/brooswit/.mcp.json",
      "--settings", JSON.stringify({ enabledMcpjsonServers: ["atlassian", "yappr"] }),
      "--dangerously-load-development-channels=server:atlassian",
      "--dangerously-load-development-channels=server:yappr",
    ]);
    // FALSIFIER: a channel value standing alone in argv is what `claude --bg`
    // took as the session's first prompt ("server:rocketr"), never registering it.
    expect(args.filter((value) => value.startsWith("server:"))).toEqual([]);
    // FALSIFIER: without this the session sits `blocked` on an approval prompt.
    expect(approvalIn(io, "/home/op/code/brooswit")).toEqual(["atlassian", "yappr"]);
  });

  test("BAKR_MCP_NOTIFICATION_SERVERS no longer narrows it", async () => {
    const previous = process.env["BAKR_MCP_NOTIFICATION_SERVERS"];
    process.env["BAKR_MCP_NOTIFICATION_SERVERS"] = "yappr";
    try {
      const args = await claudeLaunchArgs("/home/op/code/brooswit", deps({ files: { "/home/op/code/brooswit/.mcp.json": MINECRAFT_MCP } }));
      expect(args).toContain("--dangerously-load-development-channels=server:atlassian");
    } finally {
      if (previous === undefined) delete process.env["BAKR_MCP_NOTIFICATION_SERVERS"]; else process.env["BAKR_MCP_NOTIFICATION_SERVERS"] = previous;
    }
  });

  test("a directory with no MCP servers launches with no flags and writes nothing", async () => {
    const io = memorySettings();
    const args = await claudeLaunchArgs("/home/op/code/other", deps({
      settingsIo: io,
      files: { "/home/op/code/other/.mcp.json": JSON.stringify({ mcpServers: {} }) },
    }));
    expect(args).toEqual([]);
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
});

describe("an agent's own declaration", () => {
  const DIR = "/home/op/code/rocketr";
  const files = { [`${DIR}/.mcp.json`]: ROCKETR_MCP };

  test("its servers are approved, and all but an opted-out one subscribed", async () => {
    const io = memorySettings();
    const declared: McpServerDeclaration[] = [{ name: "rocketr", notifications: true }, { name: "yappr", notifications: false }];
    const args = await claudeLaunchArgs(DIR, deps({ settingsIo: io, files }), declared);
    expect(args).toEqual([
      "--mcp-config", `${DIR}/.mcp.json`,
      "--settings", JSON.stringify({ enabledMcpjsonServers: ["rocketr", "yappr"] }),
      "--dangerously-load-development-channels=server:rocketr",
    ]);
    expect(approvalIn(io, DIR)).toEqual(["rocketr", "yappr"]);
  });

  test("the directory's MCP config is still passed when nothing is subscribed to", async () => {
    const args = await claudeLaunchArgs(DIR, deps({ files }), [{ name: "yappr", notifications: false }]);
    expect(args).toEqual(["--mcp-config", `${DIR}/.mcp.json`, "--settings", JSON.stringify({ enabledMcpjsonServers: ["yappr"] })]);
  });

  test("an empty declaration is an agent with no MCP at all, not the default", async () => {
    const io = memorySettings();
    expect(await claudeLaunchArgs(DIR, deps({ settingsIo: io, files }), [])).toEqual([]);
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
    expect(args).toContain("--dangerously-load-development-channels=server:rocketr");
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
    ["yappr", { name: "yappr", notifications: true }],
    ["yappr:no-notify", { name: "yappr", notifications: false }],
    ["my_server-2:no-notify", { name: "my_server-2", notifications: false }],
    ["notify-bridge", { name: "notify-bridge", notifications: true }],
  ])("%p parses, and prints back the same", (spec, expected) => {
    expect(parseMcpSpec(spec)).toEqual(expected);
    expect(formatMcpSpec(expected)).toBe(spec);
  });

  test("the older +notify spelling still parses, as the default it now is", () => {
    expect(parseMcpSpec("yappr+notify")).toEqual({ name: "yappr", notifications: true });
  });

  test.each(["", "+notify", ":no-notify", "yappr+other", "a/b", "yappr notify", "../x", "yappr:quiet"])("%p is refused", (spec) => {
    expect(typeof parseMcpSpec(spec)).toBe("string");
  });
});

// Measured 2026-09-18: Claude also loads `.mcp.json` from PARENT directories.
// factory-dashboard has none of its own; ~/code/brooswit-factory/.mcp.json (the
// manager's own config: rocketr as manage-brooswit-factory, yappr as
// brooswit-factory) made its session stop at "New MCP server found in this
// project: rocketr". A parent's server is another agent's identity: it is
// disabled for this agent, never approved.
describe("servers only a parent directory's .mcp.json defines", () => {
  const FACTORY = "/home/op/code/brooswit-factory";
  const PARENT_MCP = JSON.stringify({ mcpServers: { rocketr: { headers: { "x-rocketr-account": "manage-brooswit-factory" } }, yappr: {} } });
  const settingsPath = (dir: string) => `${dir}/.claude/settings.local.json`;
  const settingsOf = (io: { files: Record<string, string> }, dir: string) => JSON.parse(io.files[settingsPath(dir)] ?? "{}");

  test("are disabled for the agent, never approved or subscribed, and other settings are kept", async () => {
    const DASH = `${FACTORY}/factory-dashboard`;
    const io = memorySettings({ [settingsPath(DASH)]: JSON.stringify({ permissions: { allow: ["Bash(ls)"] }, disabledMcpjsonServers: ["yappr"] }) });
    const warnings: string[] = [];
    const args = await claudeLaunchArgs(DASH, deps({ settingsIo: io, warn: (m) => warnings.push(m), files: { [`${FACTORY}/.mcp.json`]: PARENT_MCP } }));
    // FALSIFIER: approving rocketr here would have factory-dashboard post to Rocket.Chat as the manager.
    expect(args).toEqual([]);
    expect(settingsOf(io, DASH)).toEqual({ permissions: { allow: ["Bash(ls)"] }, disabledMcpjsonServers: ["yappr", "rocketr"] });
    expect(settingsOf(io, DASH).enabledMcpjsonServers).toBeUndefined();
    expect(warnings.join("\n")).toContain("disabled rocketr");
  });

  test("the agent's own entry for the same server wins: it is approved and subscribed, never disabled", async () => {
    const YAPPR = `${FACTORY}/yappr`;
    const io = memorySettings();
    const args = await claudeLaunchArgs(YAPPR, deps({ settingsIo: io, files: {
      [`${FACTORY}/.mcp.json`]: PARENT_MCP,
      [`${YAPPR}/.mcp.json`]: JSON.stringify({ mcpServers: { yappr: {} } }),
    } }));
    expect(args).toContain("--dangerously-load-development-channels=server:yappr");
    expect(args.join(" ")).not.toContain("rocketr");
    expect(settingsOf(io, YAPPR)).toEqual({ enabledMcpjsonServers: ["yappr"], disabledMcpjsonServers: ["rocketr"] });
  });

  test("a server the workspace already disables is left alone, and an explicit disable of its own server is respected", async () => {
    const DIR = `${FACTORY}/agent`;
    const io = memorySettings({ [settingsPath(DIR)]: JSON.stringify({ disabledMcpjsonServers: ["rocketr", "yappr"] }) });
    const args = await claudeLaunchArgs(DIR, deps({ settingsIo: io, files: {
      [`${FACTORY}/.mcp.json`]: PARENT_MCP,
      [`${DIR}/.mcp.json`]: JSON.stringify({ mcpServers: { yappr: {} } }),
    } }));
    expect(args).toEqual([]);
    expect(io.files[settingsPath(DIR)]).toBe(JSON.stringify({ disabledMcpjsonServers: ["rocketr", "yappr"] }));
  });

  test("an agent opts in to a parent's server only by naming it in its own declaration", async () => {
    const DIR = `${FACTORY}/agent`;
    const io = memorySettings();
    const args = await claudeLaunchArgs(DIR, deps({ settingsIo: io, files: { [`${FACTORY}/.mcp.json`]: PARENT_MCP } }), [{ name: "yappr", notifications: true }]);
    expect(args).toContain("--dangerously-load-development-channels=server:yappr");
    expect(args.join(" ")).not.toContain("rocketr");
    // Claude finds the parent's file itself; there is no own .mcp.json to name.
    expect(args).not.toContain("--mcp-config");
    expect(settingsOf(io, DIR)).toEqual({ enabledMcpjsonServers: ["yappr"], disabledMcpjsonServers: ["rocketr"] });
  });

  test("a declared name that no .mcp.json here or above defines is still reported missing", async () => {
    const DIR = `${FACTORY}/agent`;
    const warnings: string[] = [];
    const args = await claudeLaunchArgs(DIR, deps({ settingsIo: memorySettings(), warn: (m) => warnings.push(m), files: { [`${FACTORY}/.mcp.json`]: PARENT_MCP } }), [{ name: "atlassian", notifications: true }]);
    expect(args).toEqual([]);
    expect(warnings.join("\n")).toContain("atlassian are declared but not configured");
  });

  test("an unreadable settings file is reported, not overwritten", async () => {
    const DIR = `${FACTORY}/agent`;
    const io = memorySettings({ [settingsPath(DIR)]: "{ not json" });
    const warnings: string[] = [];
    await claudeLaunchArgs(DIR, deps({ settingsIo: io, warn: (m) => warnings.push(m), files: { [`${FACTORY}/.mcp.json`]: PARENT_MCP } }));
    expect(io.files[settingsPath(DIR)]).toBe("{ not json");
    expect(warnings.join("\n")).toContain("could not update disabled");
  });

  // thatch's review of #32: moved with no yappr of its own, then given one.
  test("a disable bakr wrote is lifted once the agent defines that server itself", async () => {
    const THATCH = `/home/op/code/brooswit/thatch`;
    const io = memorySettings({ [settingsPath(THATCH)]: JSON.stringify({ enableAllProjectMcpServers: true }) });
    const files: Record<string, string> = {
      "/home/op/code/brooswit/.mcp.json": PARENT_MCP,
      [`${THATCH}/.mcp.json`]: JSON.stringify({ mcpServers: { rocketr: {} } }),
    };
    await claudeLaunchArgs(THATCH, deps({ settingsIo: io, files }));
    expect(settingsOf(io, THATCH).disabledMcpjsonServers).toEqual(["yappr"]);

    files[`${THATCH}/.mcp.json`] = JSON.stringify({ mcpServers: { rocketr: {}, yappr: {} } });
    const warnings: string[] = [];
    const args = await claudeLaunchArgs(THATCH, deps({ settingsIo: io, files, warn: (m) => warnings.push(m) }));
    // FALSIFIER: without bakr's record, the old disable wins and thatch's own yappr never loads.
    expect(args).toContain("--dangerously-load-development-channels=server:yappr");
    expect(settingsOf(io, THATCH).disabledMcpjsonServers).toEqual([]);
    expect(settingsOf(io, THATCH).enabledMcpjsonServers).toContain("yappr");
    expect(settingsOf(io, THATCH).enableAllProjectMcpServers).toBe(true);
    expect(JSON.parse(io.files[`${THATCH}/.claude/bakr-disabled-mcp.json`]!)).toEqual([]);
    expect(warnings.join("\n")).toContain("re-enabled yappr");
  });

  test("a disable bakr wrote is lifted when the agent opts in to the parent's server by name", async () => {
    const DIR = `${FACTORY}/agent`;
    const io = memorySettings();
    const files = { [`${FACTORY}/.mcp.json`]: PARENT_MCP };
    await claudeLaunchArgs(DIR, deps({ settingsIo: io, files }));
    expect(settingsOf(io, DIR).disabledMcpjsonServers).toEqual(["rocketr", "yappr"]);
    const args = await claudeLaunchArgs(DIR, deps({ settingsIo: io, files }), [{ name: "yappr", notifications: true }]);
    expect(args).toContain("--dangerously-load-development-channels=server:yappr");
    expect(settingsOf(io, DIR).disabledMcpjsonServers).toEqual(["rocketr"]);
  });

  test("a person's disable is never lifted, even when the agent defines the server", async () => {
    const DIR = `${FACTORY}/agent`;
    const io = memorySettings({
      [settingsPath(DIR)]: JSON.stringify({ disabledMcpjsonServers: ["yappr"] }),
      [`${DIR}/.claude/bakr-disabled-mcp.json`]: JSON.stringify(["rocketr"]),
    });
    const args = await claudeLaunchArgs(DIR, deps({ settingsIo: io, files: { [`${DIR}/.mcp.json`]: JSON.stringify({ mcpServers: { yappr: {} } }) } }));
    expect(args).toEqual([]);
    expect(settingsOf(io, DIR).disabledMcpjsonServers).toEqual(["yappr"]);
  });

  test("parents are every directory above, nearest first, up to the root", () => {
    expect(parentDirsOf("/home/op/code/x")).toEqual(["/home/op/code", "/home/op", "/home", "/"]);
  });
});
