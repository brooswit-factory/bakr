import { describe, expect, test } from "bun:test";
import type { PendingPermission } from "@brooswit/drovr";
import { approvalExitCode, findOwnPrompt, ownPendingPermissions, renderApproval, renderPendingPermissions, resolveOperator } from "../../src/cli/permissions";
import { EXIT_FAILURE, EXIT_REFUSAL } from "../../src/cli/exit-codes";

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

describe("resolveOperator", () => {
  test("--as wins over $USER", () => {
    expect(resolveOperator("usrr:dana", "carol")).toBe("usrr:dana");
  });

  test("$USER when --as was not given", () => {
    expect(resolveOperator(undefined, "carol")).toBe("carol");
  });

  test("nobody when $USER is unset, empty or blank and --as was not given — never an empty operator", () => {
    expect(resolveOperator(undefined, undefined)).toBeUndefined();
    expect(resolveOperator(undefined, "")).toBeUndefined();
    expect(resolveOperator(undefined, "  ")).toBeUndefined();
  });
});

describe("findOwnPrompt", () => {
  const target = { sessionId: "s-1", shortId: "w1:p1" };

  test("finds the named prompt on the agent's own pane, and approves on the pane it is on", () => {
    const moved = prompt({ paneId: "w7:p1" });
    expect(findOwnPrompt(target, [moved], moved.promptId, "@a1")).toEqual({ ok: true, prompt: moved });
  });

  test("a stale promptId is refused as prompt-changed, naming what the pane shows now", () => {
    const now = prompt({ promptId: "ffffffffffffffff" });
    expect(findOwnPrompt(target, [now], "0123456789abcdef", "@a1")).toEqual({
      ok: false, reason: "prompt-changed",
      detail: "0123456789abcdef is not pending on @a1's pane, which shows ffffffffffffffff; list again and approve that one",
    });
  });

  test("another agent's promptId is not found, even though that prompt really is pending on the host", () => {
    const theirs = prompt({ paneId: "w2:p1", sessionId: "s-2", promptId: "2222222222222222" });
    const r = findOwnPrompt(target, [theirs], theirs.promptId, "@a1");
    expect(r).toEqual({ ok: false, reason: "no-prompt", detail: "@a1's pane shows no permission prompt, so 2222222222222222 is not pending there" });
  });

  test("a pane carrying the agent's pane id but another session is not searched", () => {
    const squatter = prompt({ sessionId: "s-2" });
    expect(findOwnPrompt(target, [squatter], squatter.promptId, "@a1").ok).toBe(false);
  });
});

describe("renderApproval", () => {
  test("says what was approved, once", () => {
    expect(renderApproval('@a1 "alice"', { tool: "Bash command", request: "touch x\nCreate x", scope: "once", attemptId: "att-1" }, "/s/bakr/permission-approvals.jsonl")).toBe([
      'approved Bash command for @a1 "alice" (once)',
      "request:",
      "  touch x",
      "  Create x",
      "attempt att-1, recorded in /s/bakr/permission-approvals.jsonl",
      "",
    ].join("\n"));
  });

  test("says plainly that always stores a rule that outlives the session", () => {
    expect(renderApproval("@a1", { tool: "Write", request: "/x", scope: "always", attemptId: "a" }, "/p")).toContain("(always: a rule stored for this project, which outlives the session)");
  });
});

describe("approvalExitCode", () => {
  test("an unwritable audit or an unconfirmed answer is a failure; every other refusal is a refusal", () => {
    expect(approvalExitCode("audit-failed")).toBe(EXIT_FAILURE);
    expect(approvalExitCode("not-cleared")).toBe(EXIT_FAILURE);
    for (const reason of ["invalid-operator", "no-prompt", "prompt-changed", "option-missing"] as const) expect(approvalExitCode(reason)).toBe(EXIT_REFUSAL);
  });
});
