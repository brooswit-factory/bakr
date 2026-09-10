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

**bakr is not a task runner.** Nothing in it discovers work, assigns it, or
finishes it. The operator gives an agent its purpose by attaching to it and
talking to it.

This repository now has: a path-keyed **claim store** (BAKR-6), a
**spawn substrate** (BAKR-7) that launches/lists/stops `claude` background
sessions, and — as of BAKR-12 (implementing story BAKR-8) — the **daemon**
itself: a systemd `--user` unit with linger enabled that reads the claim
store and brings back every claimed directory's on-sessions, silently, on
a timer. No agent lifecycle (create/attach/on/off/name/archive/delete) yet
— that is epic BAKR-2, deliberately not absorbed here (see "What bakr does
NOT do yet" below).

## Running the daemon

```
bun run scripts/install.sh   # idempotent: installs the unit, enables it, enables linger
systemctl --user start bakr.service
journalctl --user -u bakr.service   # NOT the system-level journalctl — see below
```

`scripts/install.sh` does not start the service itself — that is a
separate, explicit step, so "installed" and "running" stay observably
distinct.

**One sharp edge, confirmed the hard way (BAKR-7/BAKR-8):** for a systemd
*user* unit, the system-level `journalctl -u bakr.service` (no `--user`)
prints `-- No entries --` rather than failing — a silent wrong answer that
looks like an empty log. Always use `journalctl --user -u bakr.service`.

## Exercising the daemon (provisional demo harness)

There is no real CLI yet (that is BAKR-3's job). `scripts/demo-claim.ts` and
`scripts/demo-put-on.ts` are an explicitly provisional, bare-minimum
operator surface — not a CLI grammar — that exist only so the daemon has
something real to reconcile against:

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

## What bakr does NOT do yet

The agent lifecycle action set (create/attach/on/off/name/archive/delete)
is epic BAKR-2's scope, deliberately not absorbed here — see
`session-slots.ts`'s own module comment for exactly where this story drew
that line. No real CLI grammar (BAKR-3) and no webapp (BAKR-4) either.

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

