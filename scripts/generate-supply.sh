#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/argus-supply-generate.XXXXXX")"
cp -R "$ROOT/server/src" "$BUILD_DIR/src"
cp "$ROOT/server/package.json" "$ROOT/server/tsconfig.json" "$BUILD_DIR/"
ln -s "$ROOT/node_modules" "$BUILD_DIR/node_modules"
spacetime generate --lang typescript --out-dir "$ROOT/web/src/supply_bindings" --module-path "$BUILD_DIR" --yes
echo "Bindings regenerated from $BUILD_DIR"
