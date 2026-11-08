#!/usr/bin/env bash
# Local stack: SpacetimeDB, a pool of agent workers, and the dashboard.
#   npm run demo      → database argus-supply: real FDA feed, real human-entered inventory, no simulated stock.
#   npm run sandbox   → database argus-supply-sandbox: clearly labeled synthetic sites/usage around real FDA notices.
# ARGUS_WORKERS (default 2) sets the pool size; ARGUS_AGENT_MODE=auto|llm|rules picks the agent.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SANDBOX="${ARGUS_SANDBOX:-0}"
DB_NAME="${ARGUS_SUPPLY_DB_NAME:-$([ "$SANDBOX" = 1 ] && echo argus-supply-sandbox || echo argus-supply)}"
WORKERS="${ARGUS_WORKERS:-2}"
LOG_DIR="$ROOT/logs/supply-$(date +%Y%m%d-%H%M%S)-$$"
mkdir -p "$LOG_DIR"
PIDS=()
cleanup() {
  printf '\nStopping Argus Supply…\n'
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM
# The SpacetimeDB installer puts the CLI in ~/.local/bin, which non-login shells often miss.
export PATH="$PATH:$HOME/.local/bin"
for binary in spacetime node curl; do command -v "$binary" >/dev/null || { echo "Missing $binary" >&2; exit 1; }; done
# Check the exact files the publish, worker, and web steps need. A partial install can still
# satisfy `import('spacetimedb')` while lacking the server entry point or tsc.
deps_ok() {
  local f
  for f in node_modules/spacetimedb/dist/server/index.mjs node_modules/spacetimedb/dist/server/index.d.ts \
           node_modules/.bin/tsc node_modules/.bin/vite node_modules/tsx/package.json node_modules/@anthropic-ai/sdk/package.json; do
    [ -e "$ROOT/$f" ] || return 1
  done
}
if ! deps_ok; then
  echo "Installing JavaScript dependencies…"
  (cd "$ROOT" && npm ci --no-fund --no-audit)
  deps_ok || { echo "Dependencies are still incomplete after npm ci." >&2; exit 1; }
fi
if curl -fsS -o /dev/null http://127.0.0.1:3000/v1/ping 2>/dev/null; then
  echo "Using SpacetimeDB already running on port 3000."
else
  echo "Starting local SpacetimeDB…"
  spacetime start --data-dir "$ROOT/.spacetime" --non-interactive > "$LOG_DIR/spacetimedb.log" 2>&1 &
  PIDS+=("$!")
  READY=0
  for _ in $(seq 1 80); do
    if curl -fsS -o /dev/null http://127.0.0.1:3000/v1/ping 2>/dev/null; then READY=1; break; fi
    sleep 0.5
  done
  if [ "$READY" -ne 1 ]; then cat "$LOG_DIR/spacetimedb.log"; exit 1; fi
fi
"$ROOT/scripts/publish-supply.sh" "$DB_NAME" > "$LOG_DIR/publish.log" 2>&1 || { cat "$LOG_DIR/publish.log"; exit 1; }
echo "Database published: $DB_NAME"
WORKER_IDENTITY="$(cd "$ROOT" && node --import tsx agent/src/main.ts --identity)"
echo "Worker identity: $WORKER_IDENTITY"
for i in $(seq 1 "$WORKERS"); do
  NAME="worker-$(printf "\\x$(printf %x $((96 + i)))")"
  (cd "$ROOT" && exec node --import tsx agent/src/main.ts --db "$DB_NAME" --name "$NAME") > "$LOG_DIR/$NAME.log" 2>&1 &
  PIDS+=("$!")
  echo "Started $NAME (pid $!, log $LOG_DIR/$NAME.log)"
done
if [ "$SANDBOX" = 1 ]; then
  (cd "$ROOT" && exec node --import tsx agent/src/seed-sandbox.ts --db "$DB_NAME") > "$LOG_DIR/seed.log" 2>&1 &
  PIDS+=("$!")
  echo "Seeding sandbox in the background (log $LOG_DIR/seed.log)…"
fi
WEB_PORT="${ARGUS_SUPPLY_WEB_PORT:-5173}"
while (echo > "/dev/tcp/127.0.0.1/$WEB_PORT") >/dev/null 2>&1; do WEB_PORT=$((WEB_PORT + 1)); done
# The dashboard offers admins a one-click grant for this identity; it never grants on its own.
(cd "$ROOT/web" && VITE_ARGUS_WORKER_IDENTITY="$WORKER_IDENTITY" VITE_SPACETIMEDB_DB_NAME="$DB_NAME" \
  exec "$ROOT/node_modules/.bin/vite" --host --port "$WEB_PORT" --strictPort) > "$LOG_DIR/web.log" 2>&1 &
WEB_PID=$!
PIDS+=("$WEB_PID")
sleep 2
if ! kill -0 "$WEB_PID" 2>/dev/null; then cat "$LOG_DIR/web.log"; exit 1; fi
echo "Dashboard: http://localhost:$WEB_PORT"
if [ "$SANDBOX" = 1 ]; then
  echo "Open that URL and click \"Join sandbox as admin\". Data appears as the seeder finishes."
else
  echo "Open that URL. As admin, click \"Activate FDA worker\" to start the FDA import."
fi
echo "Try failover: kill one worker pid above and watch System → Leases move to the other."
echo "Logs: $LOG_DIR"
wait
