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

mkdir -p "$UNIT_DEST_DIR"

if [[ -f "$UNIT_DEST" ]] && cmp -s "$UNIT_SRC" "$UNIT_DEST"; then
  echo "unit already installed and up to date: $UNIT_DEST"
else
  cp "$UNIT_SRC" "$UNIT_DEST"
  echo "installed unit: $UNIT_SRC -> $UNIT_DEST"
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
