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

describe("the transcript's project folder decides, not a shell cd", () => {
  const withKey = (cwd: string, key: string, dirs: string[]): ResumeCwdDeps => ({
    lastRecordedCwd: async () => cwd,
    transcriptProjectKey: async () => key,
    isDirectory: async (path) => dirs.includes(path),
  });

  test("a session that last cd'd into a separate repo inside its directory resumes in its own directory", async () => {
    // Measured 2026-09-18: the manager's last cwd was ~/code/brooswit-factory/bakr, its transcript under -home-op-code-brooswit-factory.
    const MANAGER = "/home/op/code/brooswit-factory";
    const deps = withKey(`${MANAGER}/bakr`, "-home-op-code-brooswit-factory", [MANAGER, `${MANAGER}/bakr`]);
    // FALSIFIER: the old rule resumed in bakr/, loading bakr's project memory and settings.
    expect(await resumeCwdFor("s", MANAGER, deps)).toBe(MANAGER);
  });

  test("a session that entered a worktree resumes there: its transcript moved to the worktree's folder", async () => {
    expect(await resumeCwdFor("s", AGENT, withKey(WORKTREE, "-home-op-code-factory-dashboard--claude-worktrees-first-slice", [WORKTREE]))).toBe(WORKTREE);
  });

  test("a cd below a worktree resumes in the worktree, the nearest ancestor with the transcript's folder", async () => {
    expect(await resumeCwdFor("s", AGENT, withKey(`${WORKTREE}/src/deep`, "-home-op-code-factory-dashboard--claude-worktrees-first-slice", [WORKTREE, `${WORKTREE}/src/deep`]))).toBe(WORKTREE);
  });

  test("a transcript folder matching no directory between the cwd and the agent's falls back to the agent directory", async () => {
    expect(await resumeCwdFor("s", AGENT, withKey(`${AGENT}/sub`, "-somewhere-else", [`${AGENT}/sub`]))).toBe(AGENT);
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
