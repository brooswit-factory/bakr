import { describe, expect, test } from "bun:test";
import { buildAgentStartArgv, claudePid, classifyStartupPrompt, herdrLaunch, parseHerdrReply, stateOf, withSessionId } from "../../src/spawn/herdr";
import type { CommandResult, RunCommandOptions } from "../../src/spawn";

// Screens copied from real panes (rocketr, claude 2.1.276, 2026-09-18), trimmed.
const TRUST = ` Accessing workspace:

 /home/brooswit/code/brooswit-factory/rocketr

 Quick safety check: Is this a project you created or one you trust? (Like your own code, a
 well-known open source project, or work from your team). If not, take a moment to review
 what's in this folder first.

 ❯ No, exit
   Yes, I trust this folder

 Enter to confirm · Esc to cancel`;
const CHANNELS = `  WARNING: Loading development channels

  --dangerously-load-development-channels is for local channel development only. Do not use
  this option to run channels you have downloaded off the internet.

  Channels: server:yappr, server:rocketr

  ❯ 1. I am using this for local development
    2. Exit

  Enter to confirm · Esc to cancel`;
const MCP_APPROVAL = `New MCP server found in this project: probe

MCP servers may execute code or access system resources.

  Use this MCP server
  Use this and all future MCP servers in this project
❯ Continue without using this MCP server

Enter to confirm · Esc to cancel`;
const IDLE = `● OK
────────────────
❯
────────────────
  ⏵⏵ auto mode on (shift+tab to cycle)`;

describe("startup prompts", () => {
  test("folder trust is answered with Yes (down, enter), since the cursor starts on 'No, exit'", () => {
    expect(classifyStartupPrompt(TRUST)).toEqual({ kind: "trust", keys: ["down", "enter"] });
  });

  test("the development-channels warning is accepted (enter on option 1)", () => {
    expect(classifyStartupPrompt(CHANNELS)).toEqual({ kind: "development-channels", keys: ["enter"] });
  });

  test("an MCP approval prompt is never answered by guess — approval travels on the launch instead", () => {
    const prompt = classifyStartupPrompt(MCP_APPROVAL);
    expect(prompt?.kind).toBe("unknown-blocking");
  });

  test("an idle input box is no prompt at all", () => {
    expect(classifyStartupPrompt(IDLE)).toBeUndefined();
  });
});

describe("session identity", () => {
  test.each([
    [["--mcp-config", "x"], ["--session-id", "minted", "--mcp-config", "x"], "minted"],
    [["--resume", "s1", "--mcp-config", "x"], ["--resume", "s1", "--mcp-config", "x"], "s1"],
    [["--resume", "s1", "--fork-session"], ["--resume", "s1", "--fork-session"], undefined],
    [["--session-id", "given"], ["--session-id", "given"], "given"],
  ] as const)("%p runs as %p, session %p", (input, args, sessionId) => {
    expect(withSessionId(input, () => "minted")).toEqual({ args: [...args], sessionId });
  });

  test("the agent start puts claude's args after --, where herdr passes them through untouched", () => {
    expect(buildAgentStartArgv("w1:p1", ["--resume", "s1"])).toEqual(["herdr", "agent", "start", "claude", "--kind", "claude", "--pane", "w1:p1", "--timeout", "60000", "--", "--resume", "s1"]);
  });
});

describe("herdr replies", () => {
  test("result, error, and anything else", () => {
    expect(parseHerdrReply(JSON.stringify({ result: { type: "ok" } }))).toEqual({ ok: true, result: { type: "ok" } });
    expect(parseHerdrReply(JSON.stringify({ error: { code: "agent_not_ready", message: "blocked" } }))).toEqual({ ok: false, code: "agent_not_ready", message: "blocked" });
    expect(parseHerdrReply("not json").ok).toBe(false);
  });

  test("the claude pid comes from the pane's foreground processes, not the shell or an MCP child", () => {
    expect(claudePid({ process_info: { foreground_processes: [{ pid: 327534, name: "claude" }, { pid: 328110, name: "bun" }] } })).toBe(327534);
    expect(claudePid({ process_info: { foreground_processes: [{ pid: 1, name: "fish" }] } })).toBeUndefined();
  });

  test("herdr's `done` is an idle session to the rest of bakr", () => {
    expect(stateOf("done")).toBe("idle");
    expect(stateOf("working")).toBe("working");
  });
});

describe("herdrLaunch answers the startup prompts a resident cannot", () => {
  test("trust, then development channels, then idle — each answered once with its own keys", async () => {
    const screens = [TRUST, CHANNELS];
    const sent: string[][] = [];
    let ready = false;
    const runCommand = async (argv: string[], _o: RunCommandOptions): Promise<CommandResult> => {
      const ok = (result: unknown) => ({ exitCode: 0, stdout: JSON.stringify({ result }), stderr: "" });
      if (argv[1] === "workspace" && argv[2] === "create") return ok({ workspace: { workspace_id: "w1" }, root_pane: { pane_id: "w1:p1" } });
      if (argv[1] === "agent" && argv[2] === "start") return { exitCode: 1, stdout: JSON.stringify({ error: { code: "agent_not_ready", message: "blocked" } }), stderr: "" };
      if (argv[1] === "agent" && argv[2] === "get") return ok({ agent: { agent_status: ready ? "idle" : "blocked", interactive_ready: ready, agent_session: { value: "s1" } } });
      if (argv[1] === "agent" && argv[2] === "read") return { exitCode: 0, stdout: screens[0] ?? IDLE, stderr: "" };
      if (argv[1] === "agent" && argv[2] === "send-keys") {
        sent.push(argv.slice(4));
        screens.shift();
        if (screens.length === 0) ready = true;
        return ok({ type: "ok" });
      }
      throw new Error(`unexpected ${JSON.stringify(argv)}`);
    };
    let clock = 0;
    const r = await herdrLaunch("/d", ["--resume", "s1"], "@a", { runCommand, sleep: async (ms) => { clock += ms; }, now: () => clock });
    expect(r).toEqual({ ok: true, id: "w1:p1", sessionId: "s1" });
    expect(sent).toEqual([["down", "enter"], ["enter"]]);
  });
});
