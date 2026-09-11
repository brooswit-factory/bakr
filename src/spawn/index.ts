// bakr's spawn substrate (BAKR-11, implementing story BAKR-7): launch,
// list, independently verify, and stop `claude` background sessions in a
// directory bakr is handed. See each file's own banner comment for the
// specific non-negotiable rule it exists to satisfy:
//   - launch.ts   — the only site that constructs `claude --bg`; every
//                    launch goes through its own systemd-run --user --scope
//   - stop.ts     — the only site that stops a session; always by its own
//                    recorded identity, never by killing a scope/cgroup or
//                    touching `claude daemon run`
//   - liveness.ts — pid verification is a positive fact, never an
//                    inference from absence; alive/not-verifiable/unknown
//                    are kept distinct, never collapsed to a boolean
//   - argv.ts     — pure, injection-free argv construction for all of the
//                    above, fully unit tested without shelling out
//   - parse.ts    — pure parsing of everything read back from `claude`
//   - exec.ts     — the injectable command-runner every file above depends
//                    on instead of calling Bun.spawn directly
//
// Nothing in this module resolves, adopts, or stops a session by directory
// alone (BAKR-11 §1): launch() returns the session's own id, stop()
// requires one, and the only directory-scoped listing helper (`--cwd` in
// argv.ts, `filterExactCwd` in parse.ts) is documented as narrowing, never
// deciding.
//
// Ported with credit from brooswit-factory/candlestix (see individual file
// comments for exactly what was taken from where): argv-array invocation
// throughout, the injectable RunCommand seam, `isPidAlive`, and the
// kind:"background" / throw-on-failure discipline in the listing parser.
// The liveness verdict type, `decideLiveness`, the launch-id parser, and
// stop() itself are new for this ticket — candlestix has no stop mechanism
// of its own to port (it never stops an agent it spawns).

export type { CommandResult, RunCommand, RunCommandOptions } from "./exec";
export { runCommand } from "./exec";

export type { LaunchInvocation, ListInvocation, StopInvocation } from "./argv";
export { buildLaunchInvocation, buildListInvocation, buildStopInvocation } from "./argv";

export type { BackgroundSessionInfo } from "./parse";
export { parseAgentsJson, parseLaunchId, filterExactCwd, detectStaleRegisteredCwdRefusal } from "./parse";

export type { LivenessVerdict } from "./liveness";
export { isPidAlive, decideLiveness, checkLiveness } from "./liveness";

export type { LaunchDeps, LaunchResult } from "./launch";
export { launch } from "./launch";

export type { ListDeps } from "./list";
export { listBackgroundSessions } from "./list";

export type { StopDeps, StopResult } from "./stop";
export { stopSession } from "./stop";

export type { RespawnDeps, RespawnResult } from "./respawn";
export { respawnSession, isRecognizedStaleCwdRefusal, isRecognizedMissingJobRefusal } from "./respawn";
