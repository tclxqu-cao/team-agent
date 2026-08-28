#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NATIVE_DIR="$SCRIPT_DIR/node_modules/sherpa-onnx-darwin-arm64"

if [[ ! -d "$NATIVE_DIR" ]]; then
  echo "Missing native addon. Run: npm install --prefix $SCRIPT_DIR --no-package-lock" >&2
  exit 1
fi

export DYLD_LIBRARY_PATH="$NATIVE_DIR${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}"
exec node "$SCRIPT_DIR/index.mjs" "$@"
