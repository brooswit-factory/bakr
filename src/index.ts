// bakr: a daemon that keeps long-lived agents alive inside a directory it is
// handed (not one it mints), started as a systemd --user unit with linger
// enabled (see systemd/bakr.service, scripts/install.sh). Reads the claim
// store (BAKR-6) and, for every claimed directory, brings back its
// recorded-on sessions (bakr's own session-slots store, see
// session-slots.ts) — silently, via the spawn substrate (BAKR-7). See
// daemon.ts for the reconcile cycle itself; this file only wires real
// dependencies (real paths, real `claude`/`systemd-run` invocations, a real
// clock) and starts the loop.

import { randomUUID } from "node:crypto";
import { runCommand } from "./spawn";
import { claimsPath, sessionSlotsPath, agentsPath, realRandomBytes } from "./paths";
import { runDaemonLoop, type DaemonDeps } from "./daemon";
import { log } from "./log";

// No sane default is "right" for every host — this is a starting point,
// not a measured constant. 20s keeps a genuinely dead agent's downtime
// bounded to roughly this long without spamming `claude agents --json`
// (one call per cycle regardless of how many directories are claimed, per
// this ticket's own scope) on a host that may be running other daemons'
// own polling loops too.
const DEFAULT_RECONCILE_INTERVAL_MS = 20_000;

function reconcileIntervalMs(): number {
  const raw = process.env["BAKR_RECONCILE_INTERVAL_MS"];
  if (raw === undefined || raw.length === 0) return DEFAULT_RECONCILE_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    log("error", `BAKR_RECONCILE_INTERVAL_MS="${raw}" is not a positive number — using the default of ${DEFAULT_RECONCILE_INTERVAL_MS}ms`);
    return DEFAULT_RECONCILE_INTERVAL_MS;
  }
  return parsed;
}

function realDeps(): DaemonDeps {
  return {
    runCommand,
    claimsPath: claimsPath(),
    agentsPath: agentsPath(),
    sessionSlotsPath: sessionSlotsPath(),
    now: () => Date.now(),
    generateAttemptId: () => randomUUID(),
    randomBytes: realRandomBytes,
  };
}

async function main(): Promise<void> {
  await runDaemonLoop(realDeps(), { intervalMs: reconcileIntervalMs() });
}

main().catch((err) => {
  log("error", `bakr daemon exiting on an unrecoverable error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
