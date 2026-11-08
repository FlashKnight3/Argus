#!/usr/bin/env bash
# Publish the module to a fresh disposable database, run the end-to-end checks, delete the database.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$PATH:$HOME/.local/bin"
curl -fsS -o /dev/null http://127.0.0.1:3000/v1/ping || { echo "Start SpacetimeDB first (npm run demo, or spacetime start)." >&2; exit 1; }
DB="argus-supply-verify-$(date +%s)"
cleanup() { spacetime delete "$DB" --server local --yes >/dev/null 2>&1 || true; }
trap cleanup EXIT
"$ROOT/scripts/publish-supply.sh" "$DB" > /dev/null
echo "Testing against disposable database $DB"
cd "$ROOT" && ARGUS_VERIFY_DB="$DB" node --import tsx agent/test/integration.ts
