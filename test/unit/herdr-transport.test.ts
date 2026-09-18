import { describe, expect, test } from "bun:test";
import { herdrApprovalClient, herdrPermissions, openHerdrPane, residentTransport } from "../../src/cli/herdr-transport";
import { makeFakeHost, permissionScreen } from "../support/fake-host";

describe("bakr send over herdr", () => {
  test("typing into a pane sends the text, then Enter as a key, in order", async () => {
    const sent: string[][] = [];
    const terminal = openHerdrPane("w2:p1", async (argv) => { sent.push(argv); return { exitCode: 0, stdout: "", stderr: "" }; });
    terminal.write("\x1b[200~hello\nworld\x1b[201~");
    terminal.write("\r");
    await terminal.close();
    expect(sent).toEqual([
      ["herdr", "pane", "send-text", "w2:p1", "\x1b[200~hello\nworld\x1b[201~"],
      ["herdr", "pane", "send-keys", "w2:p1", "enter"],
    ]);
  });

  test("a pane is settled at once — there is no attach client whose startup must be waited out", () => {
    const terminal = openHerdrPane("w2:p1", async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    expect(Date.now() - terminal.lastOutputAt()!).toBeGreaterThanOrEqual(800);
  });

  test("the listing it hands drovr marks only an idle session sendable, and keeps pane and legacy ids apart", async () => {
    const host = makeFakeHost();
    host.addPane({ cwd: "/c", sessionId: "idle-s", status: "idle" });
    host.addPane({ cwd: "/c", sessionId: "busy-s", status: "working" });
    host.legacy.push({ id: "abcd1234", sessionId: "legacy-s", cwd: "/c", startedAt: 1, kind: "background" });
    const listed = await residentTransport(host.runCommand).listBackground!();
    expect(listed).toEqual([
      { id: "w1:p1", sessionId: "idle-s", cwd: "/c", status: "idle" },
      { id: "w2:p1", sessionId: "busy-s", cwd: "/c", status: "working" },
      { id: "abcd1234", sessionId: "legacy-s", cwd: "/c" },
    ]);
  });

  test("a pane's screen is read from herdr, a legacy session's from claude logs", async () => {
    const reads: string[][] = [];
    const transport = residentTransport(async (argv) => { reads.push(argv); return { exitCode: 0, stdout: "screen", stderr: "" }; });
    await transport.readScreen!("w1:p1");
    await transport.readScreen!("abcd1234");
    expect(reads).toEqual([["herdr", "agent", "read", "w1:p1"], ["claude", "logs", "abcd1234"]]);
  });
});

describe("permission prompts over herdr", () => {
  test("the herdr approval client reads a pane's visible screen through the herdr CLI", async () => {
    const host = makeFakeHost();
    const pane = host.addPane({ cwd: "/work", sessionId: "s-1", screen: permissionScreen("Bash command", ["ls"]) });
    const client = herdrApprovalClient(host.runCommand);
    const listed = await client.agent.list();
    expect(listed.agents.map((a) => [a.pane_id, a.agent_session?.value])).toEqual([[pane.paneId, "s-1"]]);
    const read = await client.agent.read({ target: pane.paneId, source: "visible", strip_ansi: true });
    expect(read.read.text).toBe(pane.screen!);
    expect(host.calls).toEqual([["herdr", "agent", "list"], ["herdr", "agent", "read", pane.paneId, "--source", "visible", "--format", "text"]]);
  });

  // lead-bakr, on BAKR-36: drovr asks for strip_ansi, and herdr's --format is
  // how the CLI says it. Left to herdr's default, a default that became ansi
  // would make classifyPermissionPrompt match nothing and every blocked pane
  // would list as "no pending prompts".
  test("strip_ansi is passed to herdr as an explicit --format, never left to its default", async () => {
    const reads: string[][] = [];
    const client = herdrApprovalClient(async (argv) => { reads.push(argv); return { exitCode: 0, stdout: "screen", stderr: "" }; });
    await client.agent.read({ target: "w1:p1", source: "visible", strip_ansi: true });
    await client.agent.read({ target: "w1:p1", source: "recent", strip_ansi: false, lines: 40 });
    await client.agent.read({ target: "w1:p1", source: "visible" });
    expect(reads).toEqual([
      ["herdr", "agent", "read", "w1:p1", "--source", "visible", "--format", "text"],
      ["herdr", "agent", "read", "w1:p1", "--source", "recent", "--lines", "40", "--format", "ansi"],
      ["herdr", "agent", "read", "w1:p1", "--source", "visible"],
    ]);
  });

  test("the listing drovr runs reads every pane with --format text", async () => {
    const host = makeFakeHost();
    host.addPane({ cwd: "/work", sessionId: "s-1", screen: permissionScreen("Bash command", ["ls"]) });
    host.addPane({ cwd: "/work", sessionId: "s-2" });
    await herdrPermissions(host.runCommand).list();
    const reads = host.calls.filter((c) => c[2] === "read");
    expect(reads).toHaveLength(2);
    for (const read of reads) expect(read.slice(-2)).toEqual(["--format", "text"]);
  });

  // lead-drovr, on BAKR-38: approvePermission also calls agent.get (for the
  // audit's label and session) and agent.sendKeys (the answer itself).
  test("agent.get and agent.sendKeys reach herdr as `agent get` and `agent send-keys <pane> <keys…>`", async () => {
    const host = makeFakeHost();
    const pane = host.addPane({ cwd: "/work", sessionId: "s-1", screen: permissionScreen("Bash command", ["ls"]) });
    const client = herdrApprovalClient(host.runCommand);
    const got = await client.agent.get(pane.paneId);
    expect([got.agent.pane_id, got.agent.agent_session?.value]).toEqual([pane.paneId, "s-1"]);
    await client.agent.sendKeys({ target: pane.paneId, keys: ["down", "enter"] });
    expect(host.calls).toEqual([["herdr", "agent", "get", pane.paneId], ["herdr", "agent", "send-keys", pane.paneId, "down", "enter"]]);
    expect(pane.answered).toEqual(["Yes, and always allow access to this directory from this project"]);
  });

  test("a herdr error from get or send-keys is thrown, never read as success", async () => {
    const client = herdrApprovalClient(async () => ({ exitCode: 1, stdout: JSON.stringify({ error: { code: "agent_not_found", message: "no such agent" } }), stderr: "" }));
    await expect(client.agent.get("w9:p1")).rejects.toThrow("herdr agent get: agent_not_found: no such agent");
    await expect(client.agent.sendKeys({ target: "w9:p1", keys: ["enter"] })).rejects.toThrow("herdr agent send-keys: agent_not_found: no such agent");
  });

  test("a herdr error is thrown, never read as an empty listing", async () => {
    const client = herdrApprovalClient(async () => ({ exitCode: 1, stdout: JSON.stringify({ error: { code: "server_unreachable", message: "no herdr" } }), stderr: "" }));
    await expect(client.agent.list()).rejects.toThrow("herdr agent list: server_unreachable: no herdr");
  });
});
