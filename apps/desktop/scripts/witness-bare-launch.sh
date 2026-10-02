#!/usr/bin/env bash
# Launches the built desktop bare — no tauri-driver, no automation — under the calling
# session, censuses its webview helper processes at 10s and 60s, then prints what the app
# itself said. Run it under xvfb-run and a session bus:
#
#   xvfb-run -a dbus-run-session -- scripts/witness-bare-launch.sh src-tauri/target/debug/desktop
set -euo pipefail

BINARY="${1:?usage: witness-bare-launch.sh path/to/binary}"

"$BINARY" > app-bare.log 2>&1 &
APP=$!
trap 'kill "$APP" 2>/dev/null || true' EXIT

census() {
  echo "=== webview census at $1 (pid ppid stat comm) ==="
  ps -eo pid,ppid,stat,comm | awk '/WebKit|bwrap|desktop/' | grep . || echo "(none)"
}
sleep 10
census 10s
sleep 50
census 60s
kill "$APP" 2>/dev/null || true
sleep 2
echo "=== the app said (bare launch) ==="
cat app-bare.log
