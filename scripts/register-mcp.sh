#!/bin/bash
# Registers this server with the Claude desktop app on macOS.
# Run this ON macOS (not in a Claude shell). Idempotent: re-running updates
# the entry in place and leaves every other MCP server alone.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
ENTRY="$REPO/dist/index.js"
COOKIE="$REPO/.cookie"
CFG_DIR="$HOME/Library/Application Support/Claude"
CFG="$CFG_DIR/claude_desktop_config.json"

NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "node not found on PATH. Install it or edit this script with its absolute path." >&2; exit 1; }
NODE="$(cd "$(dirname "$NODE")" && pwd)/$(basename "$NODE")"

[ -f "$ENTRY" ] || { echo "Not built yet. Run: npm ci && npm run build" >&2; exit 1; }
[ -f "$COOKIE" ] || echo "WARNING: no cookie at $COOKIE — run ./scripts/set-cookie.sh before using the server." >&2

# The desktop app owns this config file: it holds the settings in memory and
# writes them back when it quits, which silently reverts an edit made while it
# was running. Quit first, edit second, launch third.
if pgrep -x Claude >/dev/null 2>&1 || pgrep -f "Claude.app/Contents/MacOS/Claude" >/dev/null 2>&1; then
  cat >&2 <<'MSG'
The Claude desktop app is running. Quit it first (Cmd+Q) and run this again.

It keeps this config in memory and rewrites the file on quit, so editing now
would look like it worked and then revert the moment you quit the app.
MSG
  exit 1
fi

echo "node:   $NODE  ($("$NODE" -v))"
echo "entry:  $ENTRY"
echo "cookie: $COOKIE"
echo "config: $CFG"
echo

mkdir -p "$CFG_DIR"
if [ -f "$CFG" ]; then
  BAK="$CFG.bak.$(date +%Y%m%d%H%M%S)"
  cp "$CFG" "$BAK"
  echo "Backed up existing config to:"
  echo "  $BAK"
else
  echo '{}' > "$CFG"
  echo "No config existed; created an empty one."
fi

NODE="$NODE" ENTRY="$ENTRY" COOKIE="$COOKIE" CFG="$CFG" python3 - <<'PY'
import json, os, sys

cfg_path = os.environ["CFG"]
try:
    with open(cfg_path) as f:
        text = f.read().strip()
    cfg = json.loads(text) if text else {}
except json.JSONDecodeError as e:
    sys.exit(f"{cfg_path} is not valid JSON ({e}). Fix or move it, then re-run. Your backup is beside it.")

if not isinstance(cfg, dict):
    sys.exit(f"{cfg_path} does not contain a JSON object.")

servers = cfg.setdefault("mcpServers", {})
if not isinstance(servers, dict):
    sys.exit("mcpServers in the config is not a JSON object; fix it by hand.")

existing = sorted(k for k in servers if k != "trainingpeaks")
action = "Updated" if "trainingpeaks" in servers else "Added"

servers["trainingpeaks"] = {
    "command": os.environ["NODE"],
    "args": [os.environ["ENTRY"]],
    "env": {"TP_COOKIE_FILE": os.environ["COOKIE"]},
}

with open(cfg_path, "w") as f:
    json.dump(cfg, f, indent=2)
    f.write("\n")

print(f"{action} the 'trainingpeaks' server.")
print("Servers now registered:", ", ".join(sorted(servers)) or "(none)")
if existing:
    print("Left untouched:", ", ".join(existing))
PY

echo
echo "Verifying the file on disk..."
ENTRY="$ENTRY" CFG="$CFG" python3 - <<'PY'
import json, os, sys
d = json.load(open(os.environ["CFG"]))
got = d.get("mcpServers", {}).get("trainingpeaks", {}).get("args", [None])[0]
if got != os.environ["ENTRY"]:
    sys.exit(f"MISMATCH: the file says {got!r}. Something rewrote it — is the app running?")
print("  on disk, args[0] is correct")
PY

echo
echo "Now START the Claude desktop app (it should be closed right now)."
echo "Verify with:  python3 -c \"import json;print(sorted(json.load(open('$CFG'))['mcpServers']))\""
