import { describe, expect, test } from "bun:test";
import type { PendingPermission } from "@brooswit/drovr";
import { ownPendingPermissions, renderPendingPermissions } from "../../src/cli/permissions";

const prompt = (over: Partial<PendingPermission>): PendingPermission => ({
  tool: "Bash command", request: "ls", question: "Do you want to proceed?", options: ["Yes", "No"], cursor: 0, promptId: "0123456789abcdef",
  paneId: "w1:p1", label: undefined, sessionId: "s-1", cwd: "/work", ...over,
});

describe("ownPendingPermissions", () => {
  const target = { sessionId: "s-1", shortId: "w1:p1" };

  test("keeps the agent's own pane, by session", () => {
    const own = prompt({});
    expect(ownPendingPermissions(target, [own])).toEqual([own]);
  });

  test("keeps the agent's session even after it moved to another pane", () => {
    const moved = prompt({ paneId: "w7:p1" });
    expect(ownPendingPermissions(target, [moved])).toEqual([moved]);
  });

  test("drops every other session's pane", () => {
    expect(ownPendingPermissions(target, [prompt({ paneId: "w2:p1", sessionId: "s-2" })])).toEqual([]);
  });

  test("drops a pane that carries the agent's pane id but reports another session", () => {
    expect(ownPendingPermissions(target, [prompt({ sessionId: "s-2" })])).toEqual([]);
  });

  test("matches by pane id only when the pane reports no session", () => {
    const unnamed = prompt({ sessionId: undefined });
    expect(ownPendingPermissions(target, [unnamed, prompt({ paneId: "w2:p1", sessionId: undefined })])).toEqual([unnamed]);
  });
});

describe("renderPendingPermissions", () => {
  test("none", () => { expect(renderPendingPermissions([])).toBe("no pending prompts\n"); });

  test("marks the cursor's option and prints the promptId verbatim on its own line", () => {
    const text = renderPendingPermissions([
      prompt({ request: "rm -rf build\nClean the build", options: ["Yes", "Yes, and always allow", "No"], cursor: 2 }),
      prompt({ paneId: "w1:p2", tool: "Write", request: "/tmp/x", promptId: "fedcba9876543210" }),
    ]);
    expect(text).toBe([
      "pane: w1:p1", "tool: Bash command", "request:", "  rm -rf build", "  Clean the build", "question: Do you want to proceed?",
      "options:", "    1. Yes", "    2. Yes, and always allow", "  > 3. No", "promptId: 0123456789abcdef",
      "",
      "pane: w1:p2", "tool: Write", "request:", "  /tmp/x", "question: Do you want to proceed?",
      "options:", "  > 1. Yes", "    2. No", "promptId: fedcba9876543210",
      "",
    ].join("\n"));
  });
});
