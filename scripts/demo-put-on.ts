// EXPLICITLY PROVISIONAL demonstration harness (BAKR-12) — not a CLI
// grammar. See demo-claim.ts's own banner comment. This script does
// exactly the second thing the ticket's scope names: put one agent's
// session into an already-claimed directory's on-set, via the real spawn
// substrate — the same launch()/listBackgroundSessions() the daemon itself
// uses, and the same beginLaunch/markLaunchStarted/resolveLaunch sequence
// the daemon's own reconcile cycle follows (see daemon.ts), so this script
// exercises the real integration rather than a shortcut.
//
// Usage:
//   bun run scripts/demo-put-on.ts <directory>                 # fresh launch
//   bun run scripts/demo-put-on.ts <directory> --resume <id>   # resume a known session id
//
// Unlike the daemon's own reconcile cycle, this is a one-shot script, not a
// running loop — it performs a SECOND listing after a successful launch to
// resolve the new session id immediately, rather than waiting for a future
// reconcile cycle. That is fine here (this is an operator-facing one-shot
// action, not the "one listing per cycle" the daemon's own loop is scoped
// to) but would defeat the daemon's own per-cycle listing budget if ported
// there — it is not.

import { lstat, readlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { lookup } from "../src/claim-model";
import { load as loadClaims } from "../src/claim-store-io";
import { resolveClaimKey } from "../src/claim-key-resolve";
import { lexicallyNormalize } from "../src/claim-key";
import { claimsPath, sessionSlotsPath } from "../src/paths";
import { load as loadSlots, save as saveSlots } from "../src/session-slots-store";
import { beginLaunch, emptySessionSlots, markLaunchFailed, markLaunchStarted, resolveLaunch, sessionsOn } from "../src/session-slots";
import { launch, listBackgroundSessions, runCommand } from "../src/spawn";

function parseArgs(argv: string[]): { directory: string; resume: string | undefined } {
  const directory = argv[0];
  if (directory === undefined) {
    console.error("usage: bun run scripts/demo-put-on.ts <directory> [--resume <sessionId>]");
    process.exit(1);
  }
  let resume: string | undefined;
  const idx = argv.indexOf("--resume");
  if (idx !== -1) {
    resume = argv[idx + 1];
    if (resume === undefined) {
      console.error("--resume requires a session id");
      process.exit(1);
    }
  }
  return { directory, resume };
}

async function main(): Promise<void> {
  const { directory, resume } = parseArgs(process.argv.slice(2));

  const lexical = lexicallyNormalize(directory, { cwd: process.cwd(), home: homedir() });
  const resolved = await resolveClaimKey(lexical, { lstat, readlink });
  if (!resolved.ok) {
    console.error(`could not resolve "${directory}": ${resolved.reason}${"message" in resolved ? `: ${resolved.message}` : ""}`);
    process.exit(1);
  }
  const key = resolved.key;

  const claimsLoaded = await loadClaims(claimsPath());
  if (claimsLoaded.status !== "loaded" || lookup(claimsLoaded.state, key) === undefined) {
    console.error(`"${key}" is not claimed — run scripts/demo-claim.ts first`);
    process.exit(1);
  }

  const slotsPath = sessionSlotsPath();
  const slotsLoaded = await loadSlots(slotsPath);
  if (slotsLoaded.status === "malformed") {
    console.error(`refusing to write: session slots store at "${slotsPath}" is malformed: ${slotsLoaded.error}`);
    process.exit(1);
  }
  let state = slotsLoaded.status === "loaded" ? slotsLoaded.state : emptySessionSlots();

  const attemptId = randomUUID();
  state = beginLaunch(state, key, resume, attemptId, Date.now());
  await saveSlots(slotsPath, state); // Constraint 2 discipline, same as the daemon's own

  const claudeArgs = resume !== undefined ? ["--resume", resume] : [];
  const result = await launch(key, claudeArgs, { runCommand });
  if (!result.ok) {
    state = markLaunchFailed(state, attemptId, result.error);
    await saveSlots(slotsPath, state);
    console.error(`launch failed: ${result.error}`);
    process.exit(1);
  }
  state = markLaunchStarted(state, attemptId, result.id);
  await saveSlots(slotsPath, state);
  console.log(`launched: short id ${result.id} in "${key}"${resume !== undefined ? ` (resumed from ${resume})` : ""}`);

  const sessions = await listBackgroundSessions({ runCommand });
  const listed = sessions.find((s) => s.id === result.id);
  if (listed === undefined) {
    console.log(`not yet visible in \`claude agents --json\` — it will resolve on the daemon's next reconcile cycle, or re-run this listing later`);
    return;
  }
  state = resolveLaunch(state, result.id, listed.sessionId);
  await saveSlots(slotsPath, state);
  console.log(`resolved: session ${listed.sessionId} is on for "${key}" (on-set: ${JSON.stringify(sessionsOn(state, key))})`);
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
