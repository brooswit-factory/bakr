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

This repository is currently a **scaffold**: a TypeScript-on-bun project
skeleton, a test runner, a typecheck, a build, and CI that gates the
`engines.bun` floor below. No claim store, no spawn substrate, no daemon
process, and no agent lifecycle (create/attach/on/off/name/archive/delete)
exist yet — those are separate, later stories.

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

## Out of scope for this scaffold

No claim store, no spawn substrate, no daemon/systemd unit, no boot
restore, and no agent lifecycle action set (create/attach/on/off/name/
archive/delete/list). Those belong to later stories in this epic.
