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

`create` and `adopt` also claim the directory, durably and before the agent
record is written, because the daemon only restores agents in claimed
directories — that claim is what brings an agent back after a reboot.

| Command | Meaning |
|---|---|
| `bakr` | Claim and discover the current directory |
| `bakr list [--archived]` | List this directory's agents |
| `bakr create` | Claim the current directory, then create without auto-attaching |
| `bakr adopt <@id> [<@id> ...]` | Claim the current directory, then explicitly adopt offered orphans here |
| `bakr <id\|path\|name>` | Starts it if off, attaches if on — from any directory |
| `bakr <id\|path\|name> on\|off\|archive\|unarchive` | Change lifecycle state — from any directory |
| `bakr <id\|path\|name> delete [--yes]` | Delete, with confirmation |
| `bakr <id\|path\|name> send <message>` | Message the running agent and print its reply |
| `bakr <id\|path\|name> permissions` | List the tool-permission prompts waiting on that agent's pane |
| `bakr <id\|path\|name> approve <promptId> [--always] [--as <operator>]` | Approve one of those prompts, recorded in a 0600 audit |

**An agent's name is its directory's last two path segments** (e.g.
`~/code/brooswit-factory/bakr` is named `brooswit-factory/bakr`), grown by
one more leading segment on a collision with another agent's directory.
Custom names are gone (`create --name` and the `name`/`rename` verbs are
retired) — a ref that matches only a stale custom name from before this
change refuses with a `renamed: use <derived-name>` hint and changes
nothing. A ref is an id iff it starts with `@`; a real path iff it starts
with `/`, `./`, `../`, `~/`, or is exactly `~`; anything else — a slash
included — is a name: `bakr code/brooswit-factory` is a name, `bakr
./code/brooswit-factory` is a path. An id or a name resolves from ANY
current directory; `--dir <path>` still works as a deprecated alias (same
behaviour, plus a stderr notice) for a caller that cannot `cd` first.

Help is flag-only (`bakr --help`); `help` remains available as an agent
reference. Attach requires TTY stdin and stdout, inherits all three streams,
and propagates the attach client's exit status: `herdr agent attach <pane>`
for a session hosted in herdr, `claude attach <id>` for a legacy background
session. Bakr requires the agent's exact session in one successful listing
before handoff and points an absent target at `bakr <ref> on`; a listing
failure is never read as absence. Delete likewise refuses a non-TTY unless
`--yes` is supplied.

`send` needs no TTY. It delivers one quoted message to the agent's current,
running session and prints the reply. It is provider-neutral: the transport
comes from Drovr's `createResidentAgentMessenger`, and bakr never resumes,
forks, or wakes a session to send. Drovr proves delivery from the session's
own transcript; bakr supplies how to type into it: `herdr pane send-text` for
a session in a herdr pane (src/cli/herdr-transport.ts), `claude attach` for a
legacy background session.
An off, archived, absent, or mid-turn agent is refused (exit 1). Delivery that
cannot be proven exits 3. A reply still in progress after Drovr's five-minute
wait prints the text so far, reports `reply-pending`, and exits 1. The
transport ships in Drovr 0.7.0's release asset.

`permissions` is read-only. It lists the tool-permission prompts ("Do you
want to proceed?") waiting on that agent's own herdr pane, through Drovr's
`listPendingPermissions`, which reads every Claude pane's screen and not only
the ones herdr marks blocked. Drovr returns every pane on the host, so bakr
keeps only the agent's own: a pane that reports a session must report the
agent's current session (`restoreTarget.sessionId`), even if its pane id
matches, and only a pane that reports no session is matched by pane id. Each
prompt prints its pane, tool, request, options (`>` marks the cursor) and a
`promptId: <id>` line to copy into the command that answers it. None prints
`no pending prompts` (exit 0), and so does an agent that was never launched,
with a note saying so. A legacy `claude --bg` session has no pane to read and
is noted on stderr. An unknown agent is refused like any other verb (exit 1).
A failed pane listing exits 3.

`approve` answers one prompt `permissions` listed, through Drovr's
`approvePermission`. The `<promptId>` must be pending on that agent's own
pane, found by the same narrowing `permissions` uses. The pane approved is the
one that prompt is on, so pasting another agent's promptId is refused and never
reaches that agent's pane. Drovr then re-reads the pane and refuses a prompt
that changed since, writes an audit record before any key, checks that the
prompt left the screen, and never picks the option that switches the session
to auto mode.

- **Scope.** The default answers the plain "Yes", once. `--always` answers
  the "Yes, and always allow … from this project" option, which stores a rule
  that **outlives the session**. That option is only reachable through this
  flag.
- **Operator.** The operator is `$USER`, and `--as <operator>` overrides it
  (usrr passes `--as`). With `$USER` unset or empty and no `--as`, the command
  is a usage error (exit 2) before any pane is read.
- **Audit.** Records go to `$XDG_STATE_HOME/bakr/permission-approvals.jsonl`
  (`~/.local/state/bakr/` by default), beside `agents.json` and never in the
  claimed directory. Each attempt writes an `approving` record before any
  key, then its outcome; a refusal after the pane is re-read is recorded too.
  The file is created mode 0600 by the same `open` that creates it, and
  appending never changes its mode. A file already wider than 0600, or a
  symlink, at that path is refused: that is `audit-failed`, and nothing is
  pressed.
- **Output.** On success it prints the tool, the request and the scope
  (exit 0).
- **Refusals.** Every refusal prints `<reason>: <detail>` with Drovr's detail,
  and nothing further is pressed: no retry, and no fallback to another option.
  - `prompt-changed`, `no-prompt`, `option-missing` and `invalid-operator`
    exit 1.
  - `audit-failed` and `not-cleared` exit 3; `not-cleared` means the keys
    were sent but the prompt stayed on screen.

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

### Which MCP servers an agent gets, and hears from

Channels are on. Every MCP server an agent has is approved for it and
subscribed to: its session is launched with each server's development
channel, so a server can push messages (a yappr message, a Rocket.Chat DM)
straight into the conversation. No opt-in is needed.

An agent with no declaration of its own has every server its directory's
`.mcp.json` configures. A declaration narrows that, or opts one server out
of notifications:

```
bakr create --mcp rocketr --mcp yappr
bakr <name> mcp                           # show it, and what the next start carries
bakr <name> mcp rocketr yappr:no-notify   # replace it (writes the approval now)
bakr <name> mcp default                   # back to every server in .mcp.json
```

The servers themselves are still defined in the directory's `.mcp.json`; a
declared server it does not configure is dropped from the start and
reported. `BAKR_MCP_NOTIFICATION_SERVERS` is no longer read (the daemon warns
if it is still set).

bakr writes the approval (Claude's `enabledMcpjsonServers`, and the same on
the launch as `--settings`) before every start, respawns included, so a
fresh session never sits `blocked` on an approval prompt nobody can answer.

### Relaunching an agent to pick up its channels

A running session keeps the flags it was launched with: `bakr <agent> off`
then `on` respawns the same session, channels and all, as they were. To
carry changed channels into a running agent without losing its
conversation:

```
bakr rocketr relaunch      # one agent
bakr relaunch --all        # every `on` agent on this host
```

`relaunch` stops the session and resumes it (`--resume <session>`) in a new
herdr pane with the current channel flags: the same session id and
conversation, never a fork (a fork that is never prompted writes no
transcript, so relaunching a relaunch could lose the conversation). It is
also how a session still running under legacy `claude --bg` moves into
herdr. It refuses, changing nothing, an agent that is off, has no session
yet, is mid-turn, or is the session running the command. If the new session
does not come up, the agent is left `off` and the output says how to bring
the old one back (`bakr <agent> on`).

### Where sessions run: herdr panes

Every session bakr starts runs interactively in its own herdr workspace pane
(`bakr <agent-id>`), never as `claude --bg`: measured on claude 2.1.276, a
background session never delivers a channel frame as a turn, while the same
session in a terminal pane does. bakr answers the two startup prompts a
resident cannot (folder trust, and the development-channels warning for the
channels bakr itself asked for) and reports any other blocking prompt rather
than guessing. A restore resumes the same session in a new pane with the
agent's current flags. Requirements: `herdr` on the PATH bakr runs with, and
the herdr server running as its own user service (`herdr.service`), so that
restarting bakr never takes a pane down. The prompt answering is interim: it
moves to drovr's host when that ships (src/spawn/herdr.ts keeps its shape).

`delete` of an agent whose launch crashed before it ever held a session
(claude lists that launch as failed) now deletes it, instead of parking it
as archived with "nothing to stop".

bakr decides *which servers*; it never spells a vendor flag or settings key.
drovr's `applyMcpAccess` and `buildProviderLaunchArgs` do, so the provider
contract lives in one place for every substrate that launches one. See
`src/launch-config.ts`.

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

The second command launches a real session in a herdr pane (via the spawn
substrate) and records its session id as "on" for that directory. Stop the
daemon (or close the pane's workspace) and restart the daemon to see it
come back — the same session resumed in a new pane; no turn is ever
submitted on restore.

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

Every launch runs in its own herdr workspace pane, under the herdr server
rather than bakr.service; nothing stops a session any way but closing that
pane's workspace (or `claude stop <id>` for a legacy background session),
always found by its exact session id in a fresh listing; nothing kills a
scope, a cgroup, or `systemctl --user stop`s anything to stop an agent;
nothing resolves, adopts, or restores a session by matching its directory
alone. See the PR description for the hazard
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
