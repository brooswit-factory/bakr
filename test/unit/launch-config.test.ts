import { describe, expect, test } from "bun:test";
import {
  claudeLaunchArgs,
  mcpConfigPathFor,
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
    readMcpConfig: overrides.readMcpConfig ?? (async (path: string) => files[path]),
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

  test("a host that configures nothing launches exactly as it did before", async () => {
    let read = false;
    const args = await claudeLaunchArgs("/home/op/code/brooswit", deps({
      notificationServers: [],
      readMcpConfig: async () => { read = true; return MINECRAFT_MCP; },
    }));
    expect(args).toEqual([]);
    // Nothing is configured, so the launch path does not even read the directory.
    expect(read).toBe(false);
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
      readMcpConfig: async () => contents,
    }));
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
  ])("a configured list of %p reads as %p", (raw, expected) => {
    expect(parseNotificationServers(raw as string | undefined)).toEqual(expected as string[]);
  });
});
