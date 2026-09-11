// BAKR-22 DoD item 6 — live demonstration through bakr's REAL daemon entry
// point (src/spawn/launch.ts's launch(), list.ts's listBackgroundSessions()),
// not a hand-written replica of the invocation shape.
//
// Scratch claimed directory, real `claude` via the real systemd-run
// --user --scope wrapper this substrate always uses (buildLaunchInvocation).
// Restore passes NO PROMPT — claudeArgs is exactly `["--resume", fullId]`,
// matching daemon.ts's own reconcile-loop call shape. Intended to be run in
// a clean, non-nested shell (not from inside a Claude Code agent session)
// per BAKR-22's own confound findings.
//
// Usage:
//   bun run scripts/bakr22-daemon-entrypoint-demo.ts launch <scratch-dir>
//   bun run scripts/bakr22-daemon-entrypoint-demo.ts restore <scratch-dir> <fullSessionId>
//   bun run scripts/bakr22-daemon-entrypoint-demo.ts find <scratch-dir> <fullSessionId>

import { runCommand, launch, listBackgroundSessions, stopSession } from "../src/spawn";

const deps = { runCommand };

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function findByFullId(dir: string, fullId: string) {
  const sessions = await listBackgroundSessions(deps, { underCwd: dir });
  return sessions.find((s) => s.sessionId === fullId);
}

async function main() {
  const [cmd, dir, arg] = process.argv.slice(2);
  if (!cmd || !dir) {
    console.error("usage: bakr22-daemon-entrypoint-demo.ts <launch|restore|find> <scratch-dir> [fullSessionId]");
    process.exit(1);
  }

  if (cmd === "launch") {
    console.log("=== bakr's real launch(), no claudeArgs — exactly the initial 'on' shape ===");
    const result = await launch(dir, [], deps);
    console.log(JSON.stringify(result));
    if (!result.ok) throw new Error("launch failed: " + result.error);
    await sleep(3000);
    const sessions = await listBackgroundSessions(deps, { underCwd: dir });
    const info = sessions.find((s) => s.id === result.id);
    if (!info) throw new Error("could not find launched session in listing");
    console.log(`RESULT shortId=${result.id} fullId=${info.sessionId}`);
    return;
  }

  if (cmd === "restore") {
    if (!arg) throw new Error("restore needs the full session id");
    console.log(`=== bakr's real launch(), claudeArgs=["--resume", ${arg}] — exactly daemon.ts's reconcile-loop restore shape, no prompt ===`);
    const result = await launch(dir, ["--resume", arg], deps);
    console.log(JSON.stringify(result));
    if (!result.ok) throw new Error("restore failed: " + result.error);
    await sleep(3000);
    const info = await findByFullId(dir, arg);
    console.log(`RESULT restoredShortId=${result.id} sameFullIdStillListed=${info !== undefined ? info.sessionId === arg : "NOT_LISTED_UNDER_ORIGINAL_ID"}`);
    // also report what full session id the NEW short id maps to
    const sessions = await listBackgroundSessions(deps, { underCwd: dir });
    console.log("ALL_SESSIONS " + JSON.stringify(sessions));
    return;
  }

  if (cmd === "stop") {
    if (!arg) throw new Error("stop needs the short id");
    const result = await stopSession(arg, deps);
    console.log(JSON.stringify(result));
    return;
  }

  // MEASUREMENT ONLY, not a shipped primitive: `claude respawn <shortId>`
  // via the same injectable `runCommand` this substrate uses everywhere
  // else, so a candidate `respawnSession()` would be a thin, testable
  // wrapper around exactly this call if the design adopts it.
  if (cmd === "respawn") {
    if (!arg) throw new Error("respawn needs the short id");
    const result = await runCommand(["claude", "respawn", arg], { timeoutMs: 20000 });
    console.log(JSON.stringify(result));
    return;
  }

  if (cmd === "find") {
    if (!arg) throw new Error("find needs the full session id");
    const sessions = await listBackgroundSessions(deps, { underCwd: dir, includeAll: true });
    console.log(JSON.stringify(sessions, null, 2));
    return;
  }

  throw new Error("unknown command: " + cmd);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
