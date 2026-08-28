#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MODEL_ROOT="$SCRIPT_DIR/../.agent-data/asr-models"
MODEL_NAME="sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30"
ARCHIVE="$MODEL_ROOT/$MODEL_NAME.tar.bz2"
MODEL_DIR="$MODEL_ROOT/$MODEL_NAME"
MODEL_URL="https://api.github.com/repos/k2-fsa/sherpa-onnx/releases/assets/268558776"
EXPECTED_SHA256="5a2832047ea1f97dd0dc595b816c230c4bafad65cfc0341fa57517cadc50afd0"

if [[ -f "$MODEL_DIR/tokens.txt" ]]; then
  echo "$MODEL_DIR"
  exit 0
fi

mkdir -p "$MODEL_ROOT"
curl \
  --fail \
  --location \
  --continue-at - \
  --header "Accept: application/octet-stream" \
  --output "$ARCHIVE" \
  "$MODEL_URL"

ACTUAL_SHA256="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
if [[ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]]; then
  echo "Model checksum mismatch: expected $EXPECTED_SHA256, got $ACTUAL_SHA256" >&2
  exit 1
fi

tar -xjf "$ARCHIVE" -C "$MODEL_ROOT"
rm "$ARCHIVE"

if [[ ! -f "$MODEL_DIR/tokens.txt" ]]; then
  echo "Model archive did not create the expected directory: $MODEL_DIR" >&2
  exit 1
fi

echo "$MODEL_DIR"
