#!/usr/bin/env bash
# Publish the module to a fresh disposable database, run the end-to-end checks, delete the database.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$PATH:$HOME/.local/bin"
curl -fsS -o /dev/null http://127.0.0.1:3000/v1/ping || { echo "Start SpacetimeDB first (npm run demo, or spacetime start)." >&2; exit 1; }
DB="argus-supply-verify-$(date +%s)"
cleanup() { spacetime delete "$DB" --server local --yes >/dev/null 2>&1 || true; }
trap cleanup EXIT
export ARGUS_TEST_OIDC_PORT="${ARGUS_TEST_OIDC_PORT:-$((20000 + RANDOM % 20000))}"  # fresh issuer each run (the server caches JWKS per issuer)
# Sign-in is verified against a local test issuer (agent/test/oidc.ts) standing in for SpacetimeAuth.
export ARGUS_TEST_INGEST_KEY="test-ingest-$RANDOM$RANDOM"
OIDC_ISSUERS="http://localhost:${ARGUS_TEST_OIDC_PORT:-4499}" OIDC_CLIENT_IDS="client_argus_test" INGEST_API_KEY="$ARGUS_TEST_INGEST_KEY" \
  "$ROOT/scripts/publish-supply.sh" "$DB" > /dev/null
echo "Testing against disposable database $DB"
cd "$ROOT" && ARGUS_VERIFY_DB="$DB" node --import tsx agent/test/integration.ts
