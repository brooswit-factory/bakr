// Delete-confirmation policy ported from brooswit-factory/candlestix
// src/cli/confirm.ts at 13a520aa90464ec1b79ba2324864c074b0f51a3c.
export async function confirmDelete(yes: boolean, ref: string, deps: { stdinIsTTY: boolean; prompt: (text: string) => Promise<string> }): Promise<{ ok: true } | { ok: false; message: string }> {
  if (yes) return { ok: true };
  if (!deps.stdinIsTTY) return { ok: false, message: `refusing to delete "${ref}": stdin is not a TTY; pass --yes/-y to confirm non-interactively` };
  const answer = (await deps.prompt(`Delete "${ref}"? Type "yes" to confirm: `)).trim().toLowerCase();
  return answer === "yes" || answer === "y" ? { ok: true } : { ok: false, message: "delete cancelled (not confirmed)" };
}
