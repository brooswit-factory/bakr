#!/usr/bin/env bash
# Idempotent install for the bakr systemd --user unit. Safe to re-run: every
# step below is a no-op (or converges to the same end state) if already
# done. Does NOT start the service — that is left as an explicit, separate
# step (`systemctl --user start bakr.service`) so "installed" and "running"
# stay observably distinct, which is also what BAKR-8's own cold-start
# demonstration needs to be a real before/after rather than baked into
# install.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
UNIT_SRC="$REPO_ROOT/systemd/bakr.service"
UNIT_DEST_DIR="$HOME/.config/systemd/user"
UNIT_DEST="$UNIT_DEST_DIR/bakr.service"

if [[ ! -f "$UNIT_SRC" ]]; then
  echo "error: unit file not found at $UNIT_SRC" >&2
  exit 1
fi

# BAKR-13 (review of PR #10, defect 3): the unit's ExecStart is a template
# (see systemd/bakr.service's own comment) — %h alone cannot express "this
# clone's location" or "this install's bun", so both must be resolved and
# substituted HERE, into the copy actually written, never left for the
# reader to fill in and never left as the one clone path this repo happens
# to have been scaffolded at.
ENTRY_POINT="$REPO_ROOT/src/index.ts"
BUN_PATH="$(command -v bun || true)"

# Refuse loudly rather than install a unit whose ExecStart cannot possibly
# run — this is the exact failure the review demonstrated: the previous
# installer copied the unit verbatim, never checked ExecStart resolved, and
# reported success anyway while the installed unit could only ever fail at
# boot (Restart=on-failure retrying it every 5s, forever).
if [[ -z "$BUN_PATH" ]]; then
  echo "error: no \`bun\` found on PATH — cannot resolve the ExecStart this unit needs; install bun and re-run" >&2
  exit 1
fi
if [[ ! -f "$ENTRY_POINT" ]]; then
  echo "error: ExecStart target does not exist: $ENTRY_POINT — refusing to install a unit that cannot start" >&2
  exit 1
fi

mkdir -p "$UNIT_DEST_DIR"

RENDERED_UNIT="$(sed \
  -e "s|@@BUN_PATH@@|$BUN_PATH|g" \
  -e "s|@@REPO_ROOT@@|$REPO_ROOT|g" \
  "$UNIT_SRC")"

if [[ -f "$UNIT_DEST" ]] && [[ "$RENDERED_UNIT" == "$(cat "$UNIT_DEST")" ]]; then
  echo "unit already installed and up to date: $UNIT_DEST"
else
  printf '%s\n' "$RENDERED_UNIT" > "$UNIT_DEST"
  echo "installed unit: $UNIT_SRC -> $UNIT_DEST (ExecStart resolved to: $BUN_PATH run $ENTRY_POINT)"
fi

systemctl --user daemon-reload
echo "daemon-reload: ok"

systemctl --user enable bakr.service
echo "enabled: bakr.service"

# loginctl enable-linger is what makes a user unit start at boot WITHOUT a
# login session — without it, "starts when the machine starts" is simply
# false. Idempotent: re-running this when linger is already on is a no-op.
LINGER_USER="${USER:-$(id -un)}"
loginctl enable-linger "$LINGER_USER"
echo "linger enabled for: $LINGER_USER"

echo
echo "install complete. bakr.service is enabled and will start at boot."
echo "it is NOT started yet — start it explicitly with:"
echo "  systemctl --user start bakr.service"
echo "check it with:"
echo "  systemctl --user status bakr.service"
echo "  journalctl --user -u bakr.service"
