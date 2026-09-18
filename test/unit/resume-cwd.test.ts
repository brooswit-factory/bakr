import { describe, expect, test } from "bun:test";
import { isWithin, lastCwdIn, resumeCwdFor, type ResumeCwdDeps } from "../../src/resume-cwd";

const AGENT = "/home/op/code/factory-dashboard";
const WORKTREE = `${AGENT}/.claude/worktrees/first-slice`;

const deps = (cwd: string | undefined, dirs: string[] = [WORKTREE]): ResumeCwdDeps => ({
  lastRecordedCwd: async () => cwd,
  isDirectory: async (path) => dirs.includes(path),
});

describe("where a session resumes", () => {
  test("in the worktree its conversation moved into — claude refuses a resume from anywhere else", async () => {
    expect(await resumeCwdFor("s", AGENT, deps(WORKTREE))).toBe(WORKTREE);
  });

  test.each([
    ["no transcript", undefined, [WORKTREE]],
    ["the agent directory itself", AGENT, [WORKTREE]],
    ["a worktree that no longer exists", WORKTREE, []],
    ["a directory outside the agent's", "/home/op/elsewhere", ["/home/op/elsewhere"]],
    ["a sibling that only shares a prefix", `${AGENT}-other`, [`${AGENT}-other`]],
  ] as const)("in the agent directory when the recorded cwd is %s", async (_label, cwd, dirs) => {
    expect(await resumeCwdFor("s", AGENT, deps(cwd, [...dirs]))).toBe(AGENT);
  });
});

describe("reading a transcript's last cwd", () => {
  test("the latest record with a cwd wins; partial or foreign lines are skipped", () => {
    const text = [
      JSON.stringify({ type: "user", cwd: AGENT }),
      JSON.stringify({ type: "assistant", cwd: WORKTREE }),
      JSON.stringify({ type: "summary" }),
      '{"type":"assistant","cwd":"/half-writ',
    ].join("\n");
    expect(lastCwdIn(text)).toBe(WORKTREE);
    expect(lastCwdIn("")).toBeUndefined();
  });

  test("within means the directory itself or beneath it", () => {
    expect(isWithin(WORKTREE, AGENT)).toBe(true);
    expect(isWithin(AGENT, AGENT)).toBe(true);
    expect(isWithin(`${AGENT}-other`, AGENT)).toBe(false);
  });
});
