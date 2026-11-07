#!/usr/bin/env bash
# Argus — one command to launch the whole demo on one laptop, fully offline.
#
#   1. local SpacetimeDB server         (spacetime start, :3000)
#   2. publish the module               (server/ → database "argus")
#   3. ML sidecar                       (forecasts + rankings)
#   4. scenario simulator               (paused; press play on the dashboard)
#   5. commander dashboard              (http://localhost:5173, intake at /#/intake)
#
# Usage: scripts/start-demo.sh [stadium|forward]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCENARIO="${1:-stadium}"
case "$SCENARIO" in
  stadium) SCENARIO_FILE="$ROOT/scenarios/stadium_collapse.json" ;;
  forward) SCENARIO_FILE="$ROOT/scenarios/forward_station.json" ;;
  *.json)  SCENARIO_FILE="$SCENARIO" ;;
  *) echo "unknown scenario '$SCENARIO' (use stadium | forward | path/to/file.json)"; exit 1 ;;
esac

LOG_DIR="$ROOT/logs"
mkdir -p "$LOG_DIR"
PIDS=()
cyan() { printf '\033[36m%s\033[0m\n' "$*"; }
dim()  { printf '\033[2m%s\033[0m\n' "$*"; }

cleanup() {
  echo
  cyan "Stopping Argus…"
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "✗ '$1' not found. $2"; exit 1; }
}
need spacetime "Install SpacetimeDB once (while online): curl -sSf https://install.spacetimedb.com | sh"
need node "Install Node.js 22+."
need python3 "Install Python 3.10+."

cyan "▸ Argus — every patient seen, every resource watched."

# ── 1. SpacetimeDB ───────────────────────────────────────────────────────────
if curl -fsS -o /dev/null http://127.0.0.1:3000/v1/ping 2>/dev/null; then
  dim "  SpacetimeDB already running on :3000"
else
  cyan "▸ Starting SpacetimeDB (local, standalone)…"
  spacetime start > "$LOG_DIR/spacetimedb.log" 2>&1 &
  PIDS+=($!)
  for _ in $(seq 1 60); do
    curl -fsS -o /dev/null http://127.0.0.1:3000/v1/ping 2>/dev/null && break
    sleep 0.5
  done
fi

# ── 2. Dependencies (first run only; needs network once) ─────────────────────
if [ ! -d "$ROOT/node_modules" ]; then
  cyan "▸ Installing JS dependencies (first run)…"
  (cd "$ROOT" && npm install --no-fund --no-audit)
fi
if [ ! -x "$ROOT/ml/.venv/bin/python" ]; then
  cyan "▸ Creating Python venv for the ML sidecar (first run)…"
  python3 -m venv "$ROOT/ml/.venv"
  "$ROOT/ml/.venv/bin/pip" install -q -e "$ROOT/ml"
fi
PY="$ROOT/ml/.venv/bin/python"

# ── 3. Publish module ────────────────────────────────────────────────────────
cyan "▸ Publishing the Argus module to SpacetimeDB…"
(cd "$ROOT/server" && spacetime publish argus --server local --module-path . --delete-data=on-conflict --yes) \
  > "$LOG_DIR/publish.log" 2>&1 || { cat "$LOG_DIR/publish.log"; exit 1; }

# ── 4. ML sidecar + simulator ────────────────────────────────────────────────
cyan "▸ Starting ML sidecar and scenario simulator ($(basename "$SCENARIO_FILE"))…"
(cd "$ROOT/ml" && "$PY" -m argus_ml.simulator "$SCENARIO_FILE") > "$LOG_DIR/simulator.log" 2>&1 &
PIDS+=($!)
sleep 1
(cd "$ROOT/ml" && "$PY" -m argus_ml.sidecar) > "$LOG_DIR/sidecar.log" 2>&1 &
PIDS+=($!)

# ── 5. Dashboard ─────────────────────────────────────────────────────────────
cyan "▸ Dashboard → http://localhost:5173    Medic intake → http://<this-laptop-ip>:5173/#/intake"
dim  "  Logs in ./logs. Press play on the dashboard. Ctrl-C stops everything."
(cd "$ROOT/web" && npx vite --host --port 5173 --strictPort) 2>&1 | sed -u 's/^/  web  │ /' &
PIDS+=($!)
wait
