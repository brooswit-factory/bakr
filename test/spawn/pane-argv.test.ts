// BAKR-61: `readPaneArgv` reads a pane's claude argv from one
// `herdr pane process-info`, in herdr 0.8.2's measured shape, and reports
// every way it can fail as `ok: false` — never a throw, never an empty argv.

import { describe, expect, test } from "bun:test";
import { readPaneArgv, type RunCommand } from "../../src/spawn";

const replying = (stdout: string, exitCode = 0): { run: RunCommand; calls: string[][] } => {
  const calls: string[][] = [];
  return { calls, run: async (argv) => { calls.push(argv); return { exitCode, stdout, stderr: "" }; } };
};

// Trimmed from a real `herdr pane process-info --pane w29:p1` on the laptop, 2026-09-19.
const MEASURED = JSON.stringify({ id: "cli:pane:process_info", result: { type: "pane_process_info", process_info: {
  pane_id: "w29:p1", shell_pid: 33871, foreground_process_group_id: 34453,
  foreground_processes: [
    { name: "claude", pid: 34453, argv: ["claude", "--resume", "e5dbdf00", "--dangerously-load-development-channels=server:rocketr"], cmdline: "claude --resume e5dbdf00 …", cwd: "/x" },
    { name: "bun", pid: 34662, argv: ["/home/u/.bun/bin/bun", "yappr/src/index.ts", "mcp"], cmdline: "…", cwd: "/x" },
  ],
} } });

describe("readPaneArgv", () => {
  test("returns the claude process's argv, not a child MCP server's, from one process-info", async () => {
    const { run, calls } = replying(MEASURED);
    expect(await readPaneArgv("w29:p1", run)).toEqual({ ok: true, argv: ["claude", "--resume", "e5dbdf00", "--dangerously-load-development-channels=server:rocketr"] });
    expect(calls).toEqual([["herdr", "pane", "process-info", "--pane", "w29:p1"]]);
  });

  test("a pane with no claude in its foreground is ok: false", async () => {
    const { run } = replying(JSON.stringify({ result: { type: "pane_process_info", process_info: { foreground_processes: [{ name: "fish", pid: 1, argv: ["fish"] }] } } }));
    expect(await readPaneArgv("w1:p1", run)).toMatchObject({ ok: false });
  });

  test("a herdr error is ok: false with herdr's message", async () => {
    const { run } = replying(JSON.stringify({ error: { code: "pane_not_found", message: "no such pane" } }), 1);
    const r = await readPaneArgv("w1:p1", run);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("no such pane");
  });

  test("a runner that throws is ok: false, never a throw", async () => {
    const r = await readPaneArgv("w1:p1", async () => { throw new Error("timed out"); });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("timed out");
  });
});
