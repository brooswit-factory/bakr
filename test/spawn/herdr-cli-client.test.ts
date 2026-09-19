import { describe, expect, test } from "bun:test";
import { HerdrError } from "@brooswit/drovr";
import { callOverCli, cliArgvFor, drovrClientOverCli } from "../../src/spawn/herdr-cli-client";
import type { CommandResult, RunCommandOptions } from "../../src/spawn";

const printing = (stdout: string, exitCode = 0) => {
  const calls: string[][] = [];
  const runCommand = async (argv: string[], _o: RunCommandOptions): Promise<CommandResult> => { calls.push(argv); return { exitCode, stdout, stderr: "" }; };
  return { calls, runCommand };
};

describe("drovr's herdr calls over the herdr CLI", () => {
  test.each([
    ["agent.start", { name: "bakr-a", kind: "claude", pane_id: "w1:p1", args: ["--resume", "s1"], timeout_ms: 60000 },
      ["herdr", "agent", "start", "bakr-a", "--kind", "claude", "--pane", "w1:p1", "--timeout", "60000", "--", "--resume", "s1"]],
    ["workspace.create", { cwd: "/d", label: "drovr bakr-a", focus: false, env: { A: "1" } },
      ["herdr", "workspace", "create", "--cwd", "/d", "--label", "drovr bakr-a", "--env", "A=1", "--no-focus"]],
    ["agent.read", { target: "w1:p1", source: "visible", strip_ansi: true }, ["herdr", "agent", "read", "w1:p1", "--source", "visible"]],
    ["pane.read", { pane_id: "w1:p1", source: "recent_unwrapped", lines: 40 }, ["herdr", "pane", "read", "w1:p1", "--source", "recent-unwrapped", "--lines", "40"]],
    ["agent.send_keys", { target: "w1:p1", keys: ["down", "enter"] }, ["herdr", "agent", "send-keys", "w1:p1", "down", "enter"]],
    ["pane.process_info", { pane_id: "w1:p1" }, ["herdr", "pane", "process-info", "--pane", "w1:p1"]],
    ["workspace.close", { workspace_id: "w1" }, ["herdr", "workspace", "close", "w1"]],
  ] as const)("%s runs %p", (method, params, argv) => {
    expect(cliArgvFor(method, params as Record<string, unknown>)).toEqual([...argv]);
  });

  test("a method drovr's host does not call is refused by name, never guessed at", async () => {
    await expect(callOverCli(printing("").runCommand, "pane.close", {})).rejects.toThrow(/pane.close is not carried/);
  });

  test("herdr's refusal comes back as the SDK's HerdrError with herdr's own code, as drovr checks it", async () => {
    const { runCommand } = printing(JSON.stringify({ error: { code: "agent_pane_busy", message: "agent target pane w1:p1 is not an available shell" } }), 1);
    const error = await callOverCli(runCommand, "agent.start", { name: "a", kind: "claude", pane_id: "w1:p1" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HerdrError);
    expect((error as HerdrError).code).toBe("agent_pane_busy");
  });

  test("a read prints the screen itself, which comes back as the read's text", async () => {
    const result = await callOverCli(printing("❯ \n").runCommand, "agent.read", { target: "w1:p1", source: "visible" }) as { read: { text: string } };
    expect(result.read.text).toBe("❯ \n");
  });

  test("the DrovrClient's service methods reach the CLI, not a socket", async () => {
    const host = printing(JSON.stringify({ result: { type: "workspace_list", workspaces: [] } }));
    const client = drovrClientOverCli(host.runCommand);
    expect(await client.workspace.list()).toEqual({ type: "workspace_list", workspaces: [] });
    expect(host.calls).toEqual([["herdr", "workspace", "list"]]);
  });
});
