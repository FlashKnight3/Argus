#!/usr/bin/env bash
# One laptop, real FDA feed, real human-entered inventory. No simulated stock.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT/logs/supply-$(date +%Y%m%d-%H%M%S)-$$"
mkdir -p "$LOG_DIR"
PIDS=()
cleanup() {
  printf '\nStopping Argus Supply…\n'
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM
for binary in spacetime node python3 curl; do command -v "$binary" >/dev/null || { echo "Missing $binary" >&2; exit 1; }; done
if ! node --input-type=module -e "import('vite'); import('spacetimedb')" >/dev/null 2>&1; then
  echo "Installing JavaScript dependencies…"
  (cd "$ROOT" && npm ci --no-fund --no-audit)
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
"$ROOT/scripts/publish-supply.sh" > "$LOG_DIR/publish.log" 2>&1 || { cat "$LOG_DIR/publish.log"; exit 1; }
echo "Database published: argus-supply"
echo "Worker identity: $(cd "$ROOT" && python3 worker/argus_supply.py --identity)"
echo "The worker will import the real FDA shortage feed after an admin grants its identity the service role."
(cd "$ROOT" && python3 worker/argus_supply.py) > "$LOG_DIR/worker.log" 2>&1 &
PIDS+=("$!")
WEB_PORT="${ARGUS_SUPPLY_WEB_PORT:-5173}"
while (echo > "/dev/tcp/127.0.0.1/$WEB_PORT") >/dev/null 2>&1; do WEB_PORT=$((WEB_PORT + 1)); done
(cd "$ROOT/web" && "$ROOT/node_modules/.bin/vite" --host --port "$WEB_PORT" --strictPort) > "$LOG_DIR/web.log" 2>&1 &
WEB_PID=$!
PIDS+=("$WEB_PID")
sleep 2
if ! kill -0 "$WEB_PID" 2>/dev/null; then cat "$LOG_DIR/web.log"; exit 1; fi
echo "Dashboard: http://localhost:$WEB_PORT"
echo "Open that URL and, in Network, grant the worker identity the service role."
echo "Logs: $LOG_DIR"
wait
