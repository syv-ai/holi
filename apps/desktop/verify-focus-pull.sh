#!/usr/bin/env bash
#
# FR-9's focus pull, verified in the running app.
#
# The interval pull was proved end to end in plan 4; the focus pull was not, and
# could not be: `Page.bringToFront` over CDP does not make Electron emit `focus`
# on a window that already has it, so the rig that proved everything else could
# not reach this one path. macOS does emit a real one when the app genuinely
# regains frontmost status, and `osascript` can drive that — no human required,
# which is the difference between a check and a check that gets run again.
#
# Everything is local: a bare repo plays GitHub, a second clone plays the
# teammate, and `vaults.add` on a pre-cloned path adopts it with its file:///
# origin intact. No OAuth app, no token, no network.
#
#   cd apps/desktop && ./verify-focus-pull.sh
#
set -euo pipefail

# Bare `node`/`npx` are broken on this machine — see the handoff. Everything
# goes through pnpm exec.
run_node() { pnpm exec node "$@"; }

ROOT=/tmp/holi-focus-check
PORT=9333
here=$(cd "$(dirname "$0")" && pwd)
cd "$here"

cleanup() {
  if [[ -n "${APP_PID:-}" ]]; then kill "$APP_PID" 2>/dev/null || true; fi
  # Scoped, never a bare `pkill -f electron`: the agent's own host is Electron.
  pkill -f "better-holi-final/node_modules/.pnpm/electron@" 2>/dev/null || true
}
trap cleanup EXIT

echo "== fixture"
rm -rf "$ROOT"
mkdir -p "$ROOT/local"
git init --bare -q -b main "$ROOT/origin.git"
git clone -q "$ROOT/origin.git" "$ROOT/teammate"
git -C "$ROOT/teammate" config user.email teammate@holi.invalid
git -C "$ROOT/teammate" config user.name Teammate
echo '# Notes' > "$ROOT/teammate/README.md"
git -C "$ROOT/teammate" add -A
git -C "$ROOT/teammate" commit -qm 'seed'
git -C "$ROOT/teammate" push -q origin main
# Pre-cloned, so vaults.add adopts it rather than reaching for GitHub.
git clone -q "$ROOT/origin.git" "$ROOT/local/notes"

echo "== launch"
HOLI_VAULT_ROOT="$ROOT" pnpm exec electron-vite dev -- --remote-debugging-port=$PORT \
  > "$ROOT/app.log" 2>&1 &
APP_PID=$!
for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:$PORT/json/list" > /dev/null 2>&1; then break; fi
  sleep 1
done
curl -sf "http://127.0.0.1:$PORT/json/list" > /dev/null || { echo "FAIL: app never opened a page"; exit 1; }

echo "== adopt the vault"
run_node cdp.mjs "window.holi.trpc({path:'vaults.add',type:'mutation',input:{remote:'local/notes'}}).then(r=>JSON.stringify(r))"
run_node cdp.mjs "window.holi.trpc({path:'vaults.open',type:'mutation',input:{remote:'local/notes'}}).then(r=>r.ok?'opened':'FAILED: '+r.message)"

echo "== a teammate publishes"
echo 'arrived by focus' > "$ROOT/teammate/focus-pull.md"
git -C "$ROOT/teammate" add -A
git -C "$ROOT/teammate" commit -qm 'focus-pull'
git -C "$ROOT/teammate" push -q origin main

# The pull interval is 180 s and the app has been up for a fraction of that, so
# anything arriving in the next few seconds arrived because of the focus.
echo "== switch away and back"
osascript -e 'tell application "Finder" to activate'
sleep 1
osascript -e 'tell application "Electron" to activate'

echo "== waiting for the pull"
for i in $(seq 1 15); do
  if [[ -f "$ROOT/local/notes/focus-pull.md" ]]; then
    echo "PASS: the focus pull landed after ${i}s (interval is 180s, so it was the focus)"
    exit 0
  fi
  sleep 1
done

echo "FAIL: nothing arrived in 15s — the focus pull did not fire"
echo "---- app log (tail) ----"
tail -30 "$ROOT/app.log"
exit 1
