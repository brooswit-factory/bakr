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

# BAKR-14 (review of PR #10, round 3): ExecStart is not a shell line —
# systemd splits it on whitespace and expands `%` specifiers on its own,
# unquoted grammar, no matter how carefully the file that CONTAINS it was
# rendered. The template now wraps each substituted argument in literal
# double quotes (see systemd/bakr.service), so this function only has to
# make the VALUE safe to sit *inside* those quotes: per systemd's own
# unit-file quoting rules, a literal backslash or double-quote inside a
# quoted argument must itself be backslash-escaped, and a literal `%` —
# quoted or not, `%`-expansion is not a quoting-aware grammar — must be
# doubled to `%%` or systemd expands it as a specifier (measured, BAKR-14:
# an unescaped `%d` inside a resolved path was silently rewritten
# mid-path into the unit's credentials directory; nothing errored, the
# path just quietly became a different path). Order matters: backslashes
# are doubled FIRST, before the quote-escaping step adds any backslashes
# of its own, so those new backslashes are never doubled a second time.
escape_systemd_arg() {
  local v=$1
  v="${v//\\/\\\\}"
  v="${v//\"/\\\"}"
  v="${v//%/%%}"
  printf '%s' "$v"
}

# In a `sed` REPLACEMENT (never its pattern), an unescaped `&` means "the
# entire matched text" and an unescaped `\` starts an escape sequence — so
# a clone path or bun path containing either would silently corrupt the
# rendered ExecStart instead of substituting literally (review of this PR,
# BAKR-13: a clone at a path containing `&` substituted the placeholder
# back into itself, and the installer went on to report success). This
# runs AFTER escape_systemd_arg, on ITS output — the backslashes that step
# may itself have introduced need the exact same protection from sed, so
# skipping this second pass would reopen the `&`/`\` corruption for any
# value escape_systemd_arg touched, not just the ones it didn't.
escape_sed_replacement() {
  printf '%s' "$1" | sed -e 's/[\&]/\\&/g'
}

BUN_PATH_ESCAPED="$(escape_sed_replacement "$(escape_systemd_arg "$BUN_PATH")")"
REPO_ROOT_ESCAPED="$(escape_sed_replacement "$(escape_systemd_arg "$REPO_ROOT")")"

RENDERED_UNIT="$(sed \
  -e "s|@@BUN_PATH@@|$BUN_PATH_ESCAPED|g" \
  -e "s|@@REPO_ROOT@@|$REPO_ROOT_ESCAPED|g" \
  "$UNIT_SRC")"

# Belt-and-suspenders (review's own suggestion): whatever the cause, a
# rendered unit that still contains a `@@..@@` placeholder is never safe to
# install — catches not just this specific hazard but any future
# substitution or templating mistake in this same shape, rather than only
# the one case measured so far.
if printf '%s' "$RENDERED_UNIT" | grep -q '@@'; then
  echo "error: unit template still contains an unsubstituted placeholder after rendering — refusing to install a unit that cannot start" >&2
  exit 1
fi

# Final guard (epic's suggestion, BAKR-14): parse the actually-rendered
# unit with systemd's own parser before installing anything, rather than
# relying only on the specific hazards enumerated above catching every way
# this could go wrong. `systemd-analyze --user verify` is non-executing
# and safe — it does not start anything and does not touch the running
# user manager — and it accepts a bare file path, so this runs against the
# rendered content directly, before it is ever written to $UNIT_DEST.
#
# What this guard can and cannot see (BAKR-14, systemd 255, measured with
# SYSTEMD_LOG_LEVEL=debug against THIS unit's own shape, not just the
# standalone probes the brief measured): `verify`'s exit code is 1 when
# the ExecStart COMMAND (its first, unquoted-whitespace-delimited token —
# here, @@BUN_PATH@@ itself) is corrupted into something unresolvable, and
# 0 otherwise — that part transfers from the brief's probes exactly.
# But @@REPO_ROOT@@ sits in ARGUMENT position, never the command, and
# verify does not resolve or existence-check argument text at all: an
# unquoted, unescaped @@REPO_ROOT@@ split by a space or expanded by a bare
# `%d` still exits 0, with the corrupted argv only visible in verify's own
# "Command Line:" debug dump, not in its exit code or default diagnostics.
# So for BUN_PATH corruption this guard is a real, independent safety net;
# for REPO_ROOT corruption specifically, it is NOT — the quoting and
# escaping above is what actually prevents that half of this ticket's own
# defect, and this guard cannot be relied on to catch a regression there.
# It stays as a cheap, no-cost check against the class it does cover, plus
# any future templating mistake that breaks the unit's syntax outright.
#
# The trap is piping this through something else (e.g. `| head`), which
# captures THAT command's exit status instead — this reads $? directly
# from an `||` assignment, never through a pipe. Genuinely untested:
# whether a non-fatal warning (e.g. an unknown unit key) can print while
# still exiting 0 — this guard treats any non-zero exit as fatal and does
# not otherwise parse the diagnostic text, so such a warning (if one
# exists) would pass through undetected rather than being caught here.
if command -v systemd-analyze >/dev/null 2>&1; then
  VERIFY_TMP="$(mktemp "${TMPDIR:-/tmp}/bakr-verify-XXXXXX.service")"
  printf '%s\n' "$RENDERED_UNIT" > "$VERIFY_TMP"
  VERIFY_STATUS=0
  VERIFY_OUTPUT="$(systemd-analyze --user verify "$VERIFY_TMP" 2>&1)" || VERIFY_STATUS=$?
  rm -f "$VERIFY_TMP"
  if [[ -n "$VERIFY_OUTPUT" ]]; then
    printf '%s\n' "$VERIFY_OUTPUT" >&2
  fi
  if [[ "$VERIFY_STATUS" -ne 0 ]]; then
    echo "error: systemd-analyze --user verify rejected the rendered unit (exit $VERIFY_STATUS) — refusing to install a unit systemd cannot start" >&2
    exit 1
  fi
else
  echo "warning: \`systemd-analyze\` not found on PATH — skipping the verify guard; the quoting/escaping above is still applied" >&2
fi

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
