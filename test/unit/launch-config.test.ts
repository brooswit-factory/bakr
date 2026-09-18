import { describe, expect, test } from "bun:test";
import {
  bakrConfigPathFor,
  claudeLaunchArgs,
  mcpConfigPathFor,
  parseDirectoryChannels,
  parseMcpServerNames,
  parseNotificationServers,
  resolveLaunchInputs,
  type LaunchConfigDeps,
} from "../../src/launch-config";

const MINECRAFT_MCP = JSON.stringify({
  mcpServers: {
    atlassian: { type: "http", url: "https://mcp.atlassian.com/v2/mcp" },
    yappr: { type: "stdio", command: "/home/op/.bun/bin/bun", args: ["yappr", "mcp"] },
  },
});

function deps(overrides: Partial<LaunchConfigDeps> & { files?: Record<string, string> } = {}): LaunchConfigDeps {
  const files = overrides.files ?? {};
  return {
    readConfigFile: overrides.readConfigFile ?? (async (path: string) => files[path]),
    notificationServers: overrides.notificationServers ?? ["yappr"],
  };
}

describe("what a launch is configured to carry", () => {
  test("a coordinator whose .mcp.json configures yappr launches subscribed to it", async () => {
    const args = await claudeLaunchArgs("/home/op/code/brooswit", deps({
      files: { "/home/op/code/brooswit/.mcp.json": MINECRAFT_MCP },
    }));
    expect(args).toEqual([
      "--mcp-config", "/home/op/code/brooswit/.mcp.json",
      "--dangerously-load-development-channels", "server:yappr",
    ]);
  });

  test("only servers the directory actually configures are requested", async () => {
    const inputs = await resolveLaunchInputs("/home/op/code/brooswit", deps({
      notificationServers: ["yappr", "absent-server"],
      files: { "/home/op/code/brooswit/.mcp.json": MINECRAFT_MCP },
    }));
    expect(inputs.mcpNotificationServers).toEqual(["yappr"]);
  });

  test("a configured server the directory never mentions leaves the launch untouched", async () => {
    const args = await claudeLaunchArgs("/home/op/code/other", deps({
      files: { "/home/op/code/other/.mcp.json": JSON.stringify({ mcpServers: { atlassian: {} } }) },
    }));
    expect(args).toEqual([]);
  });

  test("a host and directory that configure nothing launch exactly as they did before", async () => {
    const read: string[] = [];
    const args = await claudeLaunchArgs("/home/op/code/brooswit", deps({
      notificationServers: [],
      readConfigFile: async (path) => { read.push(path); return path.endsWith(".mcp.json") ? MINECRAFT_MCP : undefined; },
    }));
    expect(args).toEqual([]);
    // Nothing asks for a channel, so the launch path never even reads `.mcp.json`.
    expect(read).toEqual(["/home/op/code/brooswit/.bakr.json"]);
  });

  test.each([
    ["absent", undefined],
    ["not JSON at all", "{ this is not json"],
    ["JSON of another shape", JSON.stringify([1, 2, 3])],
    ["JSON without mcpServers", JSON.stringify({ other: true })],
    ["an mcpServers that is not an object", JSON.stringify({ mcpServers: ["yappr"] })],
  ])("configuration that is %s carries nothing rather than failing the launch", async (_label, contents) => {
    expect(parseMcpServerNames(contents)).toEqual([]);
    const args = await claudeLaunchArgs("/home/op/code/brooswit", deps({
      readConfigFile: async () => contents,
    }));
    expect(args).toEqual([]);
  });

  test("the MCP configuration read is the one the session itself would read", () => {
    expect(mcpConfigPathFor("/home/op/code/brooswit")).toBe("/home/op/code/brooswit/.mcp.json");
  });

  test("a directory's own bakr configuration sits beside its MCP configuration", () => {
    expect(bakrConfigPathFor("/home/op/code/rocketr")).toBe("/home/op/code/rocketr/.bakr.json");
  });

  test.each([
    [undefined, []],
    ["", []],
    ["   ", []],
    ["yappr", ["yappr"]],
    ["yappr,other", ["yappr", "other"]],
    ["yappr other", ["yappr", "other"]],
    ["yappr, other ", ["yappr", "other"]],
  ])("a configured list of %p reads as %p", (raw, expected) => {
    expect(parseNotificationServers(raw as string | undefined)).toEqual(expected as string[]);
  });
});

const ROCKETR_MCP = JSON.stringify({
  mcpServers: {
    rocketr: { type: "http", url: "http://127.0.0.1:8790/mcp" },
    yappr: { type: "stdio", command: "/home/op/.bun/bin/bun", args: ["yappr", "mcp"] },
  },
});

describe("a directory opting in to its own channels", () => {
  const DIR = "/home/op/code/rocketr";

  test("a directory's .bakr.json adds its channels to the host's", async () => {
    const args = await claudeLaunchArgs(DIR, deps({
      notificationServers: ["yappr"],
      files: {
        [`${DIR}/.mcp.json`]: ROCKETR_MCP,
        [`${DIR}/.bakr.json`]: JSON.stringify({ channels: ["rocketr"] }),
      },
    }));
    expect(args).toEqual([
      "--mcp-config", `${DIR}/.mcp.json`,
      "--dangerously-load-development-channels", "server:yappr", "server:rocketr",
    ]);
  });

  test("a directory opts in even when the host configures nothing", async () => {
    const inputs = await resolveLaunchInputs(DIR, deps({
      notificationServers: [],
      files: {
        [`${DIR}/.mcp.json`]: ROCKETR_MCP,
        [`${DIR}/.bakr.json`]: JSON.stringify({ channels: ["rocketr"] }),
      },
    }));
    expect(inputs).toEqual({ mcpConfigPath: `${DIR}/.mcp.json`, mcpNotificationServers: ["rocketr"] });
  });

  test("a channel the directory's .mcp.json does not configure is never requested", async () => {
    const inputs = await resolveLaunchInputs(DIR, deps({
      notificationServers: [],
      files: {
        [`${DIR}/.mcp.json`]: ROCKETR_MCP,
        [`${DIR}/.bakr.json`]: JSON.stringify({ channels: ["rocketr", "not-configured"] }),
      },
    }));
    expect(inputs.mcpNotificationServers).toEqual(["rocketr"]);
  });

  test("a server asked for by both the host and the directory is requested once", async () => {
    const inputs = await resolveLaunchInputs(DIR, deps({
      notificationServers: ["yappr", "rocketr"],
      files: {
        [`${DIR}/.mcp.json`]: ROCKETR_MCP,
        [`${DIR}/.bakr.json`]: JSON.stringify({ channels: ["rocketr", "yappr"] }),
      },
    }));
    expect(inputs.mcpNotificationServers).toEqual(["yappr", "rocketr"]);
  });

  test("a server merely configured in .mcp.json is not subscribed to without an opt-in", async () => {
    const args = await claudeLaunchArgs(DIR, deps({
      notificationServers: [],
      files: { [`${DIR}/.mcp.json`]: ROCKETR_MCP },
    }));
    expect(args).toEqual([]);
  });

  test("the directory's configuration is read afresh at every launch", async () => {
    const files: Record<string, string> = { [`${DIR}/.mcp.json`]: ROCKETR_MCP };
    const live = deps({ notificationServers: [], readConfigFile: async (path) => files[path] });
    expect(await claudeLaunchArgs(DIR, live)).toEqual([]);
    files[`${DIR}/.bakr.json`] = JSON.stringify({ channels: ["rocketr"] });
    expect(await claudeLaunchArgs(DIR, live)).toEqual([
      "--mcp-config", `${DIR}/.mcp.json`,
      "--dangerously-load-development-channels", "server:rocketr",
    ]);
  });

  test.each([
    ["absent", undefined],
    ["not JSON at all", "{ this is not json"],
    ["JSON of another shape", JSON.stringify(["rocketr"])],
    ["JSON without channels", JSON.stringify({ other: true })],
    ["a channels that is not an array", JSON.stringify({ channels: "rocketr" })],
  ])("a .bakr.json that is %s adds nothing and fails nothing", async (_label, contents) => {
    expect(parseDirectoryChannels(contents)).toEqual([]);
    const inputs = await resolveLaunchInputs(DIR, deps({
      notificationServers: ["yappr"],
      readConfigFile: async (path) => (path.endsWith(".bakr.json") ? contents : ROCKETR_MCP),
    }));
    expect(inputs.mcpNotificationServers).toEqual(["yappr"]);
  });

  test("channel entries that are not non-empty names are skipped", () => {
    expect(parseDirectoryChannels(JSON.stringify({ channels: ["rocketr", 7, "", "  ", null, " yappr "] })))
      .toEqual(["rocketr", "yappr"]);
  });
});
