import { describe, expect, test } from "bun:test";
import { herdrApprovalClient, openHerdrPane, residentTransport } from "../../src/cli/herdr-transport";
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
    expect(host.calls).toEqual([["herdr", "agent", "list"], ["herdr", "agent", "read", pane.paneId, "--source", "visible"]]);
  });

  test("a herdr error is thrown, never read as an empty listing", async () => {
    const client = herdrApprovalClient(async () => ({ exitCode: 1, stdout: JSON.stringify({ error: { code: "server_unreachable", message: "no herdr" } }), stderr: "" }));
    await expect(client.agent.list()).rejects.toThrow("herdr agent list: server_unreachable: no herdr");
  });
});
