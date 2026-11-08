#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$PATH:$HOME/.local/bin"
DB_NAME="${1:-argus-supply}"
[[ "$DB_NAME" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] || { echo "Invalid database name: $DB_NAME" >&2; exit 1; }
command -v spacetime >/dev/null || { echo "SpacetimeDB CLI is required (version 2.14.1)." >&2; exit 1; }
test -e "$ROOT/node_modules/spacetimedb/dist/server/index.mjs" && test -e "$ROOT/node_modules/.bin/tsc" || { echo "Run npm ci first." >&2; exit 1; }
BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/argus-supply-build.XXXXXX")"
cp -R "$ROOT/server/src" "$BUILD_DIR/src"
cp "$ROOT/server/package.json" "$ROOT/server/tsconfig.json" "$BUILD_DIR/"
ln -s "$ROOT/node_modules" "$BUILD_DIR/node_modules"
spacetime publish "$DB_NAME" --server local --module-path "$BUILD_DIR" --delete-data=never --yes=skip-login,break-clients
echo "Published $DB_NAME; existing data was preserved. Build staged at $BUILD_DIR"
