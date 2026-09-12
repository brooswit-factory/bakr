// Ported from brooswit-factory/candlestix src/cli/attach.ts and
// src/cli/attach-runner.ts at 13a520aa90464ec1b79ba2324864c074b0f51a3c.
export async function attachInPlace(shortId: string, deps: { stdinIsTTY: boolean; stdoutIsTTY: boolean; spawn: (id: string) => Promise<number> }): Promise<{ ok: false; message: string } | { ok: true; exitCode: number }> {
  if (!deps.stdinIsTTY || !deps.stdoutIsTTY) return { ok: false, message: "refusing to attach: stdin and stdout must both be TTYs; run this command in an interactive terminal" };
  return { ok: true, exitCode: await deps.spawn(shortId) };
}

export async function spawnClaudeAttach(shortId: string): Promise<number> {
  const child = Bun.spawn(["claude", "attach", shortId], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return child.exited;
}
