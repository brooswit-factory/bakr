# bakr

A daemon that keeps long-lived agents alive **inside a directory**. You run
`bakr` in the directory you are standing in, and it manages the agents of
that directory. Several agents can live in one directory, each with its own
conversation, all sharing that one working tree. When the machine starts,
the daemon brings back every directory's agents that were on. Much like
normal Claude, but it starts when the computer starts.

## How this differs from candlestix

`bakr` and its sibling daemon `candlestix` share one justification — agents
that are long-lived and start at boot — but differ in the context an agent
runs in:

- **candlestix** *mints* an agent's directory: an empty, per-agent home the
  daemon creates itself, keyed by a minted id.
- **bakr** is *handed* a directory: one that already exists and already has
  meaning — a repo, a `CLAUDE.md`, a git history. bakr does not create it
  and does not own its contents; it only manages the agents that live inside
  it.

That difference — created vs. given — is the whole product.

## CLI usage

Bare `bakr` claims the current directory idempotently and discovers its
non-archived agents and any explicit adoption offers. It deliberately does
not create or launch an agent. This differs from candlestix, whose bare
command creates: a bakr directory already has meaning, so spending a launch
on first discovery would be surprising.

| Command | Meaning |
|---|---|
| `bakr` | Claim and discover the current directory |
| `bakr list [--archived]` | List this directory's agents |
| `bakr create [--name <name>]` | Create without auto-attaching |
| `bakr adopt <@id> [<@id> ...]` | Explicitly adopt offered orphans here |
| `bakr <id\|name>` | Attach in the current terminal |
| `bakr <id\|name> on\|off\|archive\|unarchive` | Change lifecycle state |
| `bakr <id\|name> name\|rename <new>` | Rename |
| `bakr <id\|name> delete [--yes]` | Delete, with confirmation |

Help is flag-only (`bakr --help`); `help` remains available as an agent
reference. Attach requires TTY stdin and stdout, inherits all three streams,
and propagates `claude attach`'s exit status. On Claude Code 2.1.269, live
PTY measurement showed that attaching an absent stopped job prints “Waking
session…” and respawns it. Bakr therefore requires the agent's exact full
job ID in one successful `claude agents --json` listing before handoff and
points an absent target at `bakr <ref> on`; a listing failure is never read
as absence. Attaching and detaching without a prompt left `totalCostUSD` at
0. Delete likewise refuses a
non-TTY unless `--yes` is supplied.

| Exit | Meaning |
|---:|---|
| 0 | Success, including an already-in-state no-change |
| 1 | Typed domain refusal or declined confirmation |
| 2 | Usage error |
| 3 | Store/listing/lock/unexpected service failure |

The CLI imports the lifecycle actions directly; unlike candlestix it does
not add a daemon API, because bakr's locked stores already support multiple
writers. It also never opens a new terminal. The `on` result model reports
current-attempt launch-record clearing separately from stray fork-from-record
clearing so neither operator-visible recovery is conflated.

**bakr is not a task runner.** Nothing in it discovers work, assigns it, or
finishes it. The operator gives an agent its purpose by attaching to it and
talking to it.

This repository has: a path-keyed **claim store** (BAKR-6), a
**spawn substrate** (BAKR-7) that launches/lists/stops `claude` background
sessions, and — as of BAKR-12 (implementing story BAKR-8) — the **daemon**
itself: a systemd `--user` unit with linger enabled that reads the claim
store and brings back every claimed directory's on-sessions, silently, on
a timer, an agent lifecycle action set, and the CLI described above.

## Running the daemon

```
./scripts/install.sh   # idempotent: installs the unit, enables it, enables linger
systemctl --user start bakr.service
journalctl --user -u bakr.service   # NOT the system-level journalctl — see below
```

`scripts/install.sh` is a **bash** script (already executable in this repo,
`chmod 755`) — `bun run scripts/install.sh` does NOT work: `bun run` hands a
`.sh` file to Bun's own shell, not bash, and this script uses bash-only
syntax (`set -euo pipefail`, `${BASH_SOURCE[0]}`, `[[ ]]`), so it fails
immediately with `Unknown conditional expression operation: -f` and installs
nothing (found in BAKR-1's review of PR #10). `bash scripts/install.sh`
works identically to `./scripts/install.sh` if you prefer to spell it out.

`scripts/install.sh` does not start the service itself — that is a
separate, explicit step, so "installed" and "running" stay observably
distinct.

**Works from any clone location, not only `~/code/brooswit-factory/bakr`** —
including a clone or `bun` path containing whitespace, `%`, `&`, or `\`,
each demonstrated with `systemd-analyze --user verify` on the actually
installed unit — **except a path containing a literal `|`**, which the
installer refuses outright (below). `systemd/bakr.service`'s `ExecStart` is
a template (`"@@BUN_PATH@@" run "@@REPO_ROOT@@/src/index.ts"`); the
installer resolves `bun`'s real path (`command -v bun`) and this clone's
real root, substitutes both into the copy it writes, and **refuses to
install — no unit written, nothing enabled — if either does not resolve**
(no `bun` on `PATH`, or no `src/index.ts` at the resolved root), rather
than reporting success for a unit that can only ever fail at boot (found
in BAKR-1's review of PR #10: the previous installer copied the unit
verbatim and reported success regardless).

`ExecStart` is not a shell line — systemd splits it on whitespace and
expands `%` specifiers on its own, unquoted grammar (found in a later
round of the same review: a clone path containing a space was silently
split into two argv entries, and one containing `%d` was silently expanded
into the unit's own credentials directory, in both cases while the
installer still reported success). Both substituted arguments are now
double-quoted in the template, and the installer escapes a literal `%`,
`"`, or `\` in the resolved values before they land inside those quotes,
per systemd's own unit-file quoting rules.

The same values are *also* escaped before they reach `sed`'s replacement
side — an unescaped `&` or `\` there has special meaning (`&` means "the
whole match"), which previously let a clone path *containing* `&` silently
substitute the placeholder back into itself while the installer still
reported success (also found in review; tested by cloning to a path with a
literal `&` in it). A path containing a literal `|` still defeats this
particular `sed` invocation, which uses `|` as its own delimiter — the
installer fails loudly there (a `sed` syntax error) and writes nothing, but
this is an incidental refusal, not a designed one, so don't rely on the
exact error text.

As an independent line of defence, the installer also refuses — again,
nothing written or enabled — if the rendered unit still contains an
unsubstituted `@@..@@` placeholder for any reason, or if `systemd-analyze
--user verify` (when present on `PATH`) rejects the rendered unit outright.
**That verify guard is a real but partial safety net, not full coverage:**
its exit code reliably catches corruption of the `bun` path (the `ExecStart`
command itself) but, measured directly against this unit's own shape, does
**not** catch corruption of the clone-path argument — systemd does not
resolve or validate argument text the way it validates the command — so the
quoting/escaping above, not this guard, is what actually keeps a clone path
safe.

**One sharp edge, confirmed the hard way (BAKR-7/BAKR-8):** for a systemd
*user* unit, the system-level `journalctl -u bakr.service` (no `--user`)
prints `-- No entries --` rather than failing — a silent wrong answer that
looks like an empty log. Always use `journalctl --user -u bakr.service`.

## Exercising the daemon (legacy demo harnesses)

`scripts/demo-claim.ts` and `scripts/demo-put-on.ts` predate the real CLI and
remain diagnostic harnesses, not an operator interface:

```
bun run scripts/demo-claim.ts /path/to/a/directory
bun run scripts/demo-put-on.ts /path/to/a/directory
```

The second command launches a real `claude --bg` session (via the spawn
substrate's own scope-wrapped launch) and records its session id as "on"
for that directory. Stop the daemon (or the session, via `claude stop
<id>`) and restart the daemon to see it come back silently — no turn is
ever submitted on restore.

## bakr's own thin store: session-slots

`src/session-slots.ts` / `src/session-slots-store.ts` hold bakr's own
answer to "which claude session ids should be running in this claimed
directory" — deliberately NOT `claim-model.ts`'s `agentIds` field (which
ships no mutator, on purpose, and stays that way). Anonymous slots only: no
names, no on/off/archive/rename verbs, no per-agent metadata beyond two
raw identities per slot and the bookkeeping needed to survive a crash
mid-launch (see the module's own comment on `LaunchRecord`). Persisted at
`$XDG_STATE_HOME/bakr/session-slots.json`, alongside `claims.json`, with
the identical missing/malformed/loaded discipline the claim store uses
(see "The three constraints" below).

**Two ids per slot, not one** — found necessary live: a `durableSessionId`
(the only thing `--resume` can reliably take, fixed for the slot's whole
life) and a `liveSessionId` (the ephemeral id a listing reports right now,
used only to check liveness). Conflating the two into one field is what
let an earlier build overwrite a slot's resumable identity with a just-
rotated id that could itself fail to resume — see `session-slots.ts`'s own
module comment for the live trace that found this.

## The three constraints this story had to rule on

1. **An empty `claude agents --json` listing must never mean "nothing
   running."** `src/spawn/parse.ts`'s `parseAgentsJson` (BAKR-7, merged)
   now throws if the raw listing contained `kind:"background"` entries but
   *none* survived field validation — a systematic shape change, not one
   odd entry — and the daemon's own reconcile cycle treats a listing
   failure as a whole-cycle no-op, never a relaunch.
2. **A failed launch can leak a session bakr can never legitimately
   reclaim.** The intent to launch is persisted (`session-slots.json`)
   *before* `launch()` is even called. A failure is recorded permanently —
   logged every cycle, never retried automatically, never resolved by
   matching the claimed directory (cwd-adoption is explicitly forbidden
   throughout this codebase).
3. **A malformed claim store (or session-slots store) must never be
   silently treated as empty.** Both are reconstructable from nothing — no
   live oracle exists to rebuild them the way candlestix's registry can be
   rebuilt from `claude`'s own state. On `malformed`, the daemon starts
   (never crashloops), restores nothing, and never writes to the affected
   file again for the life of the process. `missing` (first run) is an
   ordinary, empty start.

## The hazard this story inherits from BAKR-7

Every launch goes through its own `systemd-run --user --scope` (never a
bare `claude --bg`); nothing stops a session any way but `claude stop
<id>`; nothing kills a scope, a cgroup, or `systemctl --user stop`s
anything to stop an agent; nothing resolves, adopts, or restores a session
by matching its directory alone. See the PR description for the hazard
greps and the live cgroup verification specific to this daemon.

## What bakr does not do

Bakr is not a task runner or webapp. The CLI does not use an HTTP server and
does not open new terminal windows. Installation onto a target machine's
PATH remains separate from this command implementation.

## The one command

```
bun run check
```

This chains typecheck → test → build. It is what CI runs, in the same
order, on every push and pull request.

Individual steps, if you want them separately: `bun run typecheck`,
`bun test`, `bun run build`.

## The engines floor

`package.json` declares:

```
"engines": { "bun": ">=1.3.11" }
```

### Where this number came from

candlestix (`brooswit-factory/candlestix`, read at its own `origin/main`)
declares `engines.bun >= 1.3.14` but its CI pins `bun-version: latest` —
so nothing ever tests that declared floor against a real bun. This repo
does not copy those two fields; it fixes them (see "What was taken from
candlestix" below).

Two vantage points on what floor bakr actually needs to satisfy:

- **This workspace's own host**, measured directly while scaffolding this
  repo: `bun --version` → `1.3.14`, `bun` present on `PATH` via
  `~/.bun/bin`. This is the host this scaffolding work happened on — it is
  very likely **not** the machine bakr's daemon must actually run on, so it
  is not trusted as the floor on its own.
- **The BAKR project's living brief (Confluence)**, which records the
  target laptop running bun `1.3.11` — the machine bakr is actually meant
  to run on.

Where two vantage points disagree, the floor is the lower one, because a
floor the real target machine fails is worse than no floor at all. That
gives **`1.3.11`**, which is what's declared here. This is a second-hand
figure (recorded by the BAKR project agent, not measured by this scaffold
directly against the physical target laptop) — declaring that limit
plainly rather than overclaiming a first-hand measurement of the laptop
this scaffold does not have access to.

### How the floor is actually gated, not just declared

`bun install` does **not** enforce `engines` on its own — verified directly
against this bun (`1.3.14`): a `package.json` with an impossible
`engines.bun` (`>=9999.0.0`) still installs cleanly, exit code 0. So the
floor needs a real gate, which lives in two places:

1. **`test/engines.test.ts`** reads `engines.bun` out of `package.json` at
   runtime (never a hardcoded copy of the version — a hardcoded copy can't
   detect the two drifting apart) and asserts the *actually running* bun
   satisfies it, via `Bun.semver.satisfies`.
2. **CI pins `bun-version: "1.3.11"`** in
   `.github/workflows/ci.yml` — the exact declared floor, not `latest` —
   so the test above runs against the floor itself, not against whatever
   bun happens to be newest on the runner that day.

This was demonstrated to actually gate, not just asserted: `engines.bun`
was temporarily raised above `1.3.11` on this branch, pushed, and CI went
red on the test above; then reverted. See the PR description for the linked
red run and what result would have shown the gate was decoration instead.

## What was taken from candlestix

This scaffold's shape — TypeScript, `"type": "module"`, `bun test`, a
`check` script chaining typecheck → test → build, a `src/` and a `test/` —
matches `brooswit-factory/candlestix`'s scaffold deliberately, to avoid
inventing a second convention for the same kind of daemon. Two fields were
**not** copied and were fixed instead: `engines.bun` (candlestix declares
`>=1.3.14`, untested by its CI) and the CI bun-version pin (candlestix uses
`latest`; this repo pins the declared floor — see above).

The CI workflow's `push` / `workflow_dispatch` triggers alongside
`pull_request`, and the comment explaining why, are also taken from
candlestix: a brand-new GitHub org gates `pull_request`-triggered runs so
they queue with zero jobs, which applies here since `brooswit-factory/bakr`
is a new repository.
