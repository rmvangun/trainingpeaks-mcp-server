#!/bin/bash
# Writes whatever is on the clipboard to the cookie file, mode 600.
# Run on macOS after copying the Production_tpAuth VALUE from DevTools.
# The value never gets typed, echoed, or written to shell history.
set -euo pipefail

DEST="$(cd "$(dirname "$0")/.." && pwd)/.cookie"

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
pbpaste > "$TMP"

# Strip surrounding whitespace/newlines and a pasted "Production_tpAuth=" prefix.
VALUE="$(tr -d '\r\n' < "$TMP" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^Production_tpAuth=//')"

if [ -z "$VALUE" ]; then
  echo "Clipboard is empty. Copy the cookie value first." >&2
  exit 1
fi
if [ "${#VALUE}" -lt 40 ]; then
  echo "That looks too short (${#VALUE} chars) to be the cookie value. Did you copy the name instead?" >&2
  exit 1
fi

umask 077
printf '%s' "$VALUE" > "$DEST"
chmod 600 "$DEST"
echo "Wrote ${#VALUE} characters to $DEST (mode 600)."
