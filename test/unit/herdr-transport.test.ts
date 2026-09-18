import { describe, expect, test } from "bun:test";
import { openHerdrPane, residentTransport } from "../../src/cli/herdr-transport";
import { makeFakeHost } from "../support/fake-host";

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
