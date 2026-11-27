#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
MODELS_ROOT="$REPO_ROOT/packages/desktop/.agent-data"
WAKE_KEYWORD="x iǎo zh ì @小智"
KIND="${1:-}"

case "$KIND" in
  asr)
    MODEL_NAME="sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30"
    ARCHIVE_SHA256="5a2832047ea1f97dd0dc595b816c230c4bafad65cfc0341fa57517cadc50afd0"
    ARCHIVE_URL="${VOICE_ASR_ARCHIVE_URL:-}"
    TARGET_DIR="${VOICE_ASR_MODEL_DIR:-$MODELS_ROOT/asr-models/$MODEL_NAME}"
    ;;
  kws)
    MODEL_NAME="sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01"
    ARCHIVE_SHA256="b2f7c89690dc8ce4c6ed6afeab7cd800c36ad1421fb6b6302b4a4b194cf7f35f"
    ARCHIVE_URL="${VOICE_KWS_ARCHIVE_URL:-}"
    TARGET_DIR="${VOICE_KWS_MODEL_DIR:-$MODELS_ROOT/kws-models/$MODEL_NAME}"
    ;;
  *)
    echo "Usage: bash install-model.sh {asr|kws} [--check]" >&2
    exit 2
    ;;
esac
MODE="${2:-}"
if [[ $# -gt 2 || ( -n "$MODE" && "$MODE" != "--check" ) ]]; then
  echo "Usage: bash install-model.sh {asr|kws} [--check]" >&2
  exit 2
fi

ARCHIVE_NAME="$MODEL_NAME.tar.bz2"
ARCHIVE_URL="${ARCHIVE_URL:-https://github.com/k2-fsa/sherpa-onnx/releases/download/$KIND-models/$ARCHIVE_NAME}"
CHECKSUMS="$SCRIPT_DIR/model-checksums/$KIND.sha256"
[[ "$TARGET_DIR" = /* ]] || TARGET_DIR="$PWD/$TARGET_DIR"
# dirname also strips a trailing slash when paired with basename.
TARGET_PARENT="$(dirname "$TARGET_DIR")"
TARGET_NAME="$(basename "$TARGET_DIR")"
TARGET_DIR="$TARGET_PARENT/$TARGET_NAME"

verify_model() {
  local directory="$1"
  (cd "$directory" && shasum -a 256 --quiet --check "$CHECKSUMS") >&2 || return 1
  if [[ "$KIND" == "kws" ]] && ! grep -Fxq "$WAKE_KEYWORD" "$directory/keywords.txt"; then
    echo "KWS keywords.txt must contain the default wake word: $WAKE_KEYWORD" >&2
    return 1
  fi
}

report_ready() {
  echo "Verified $MODEL_NAME" >&2
  printf '%s\n' "$TARGET_DIR"
}

if [[ -e "$TARGET_DIR" || -L "$TARGET_DIR" ]]; then
  if verify_model "$TARGET_DIR"; then
    report_ready
    exit 0
  fi
  echo "Model verification failed at $TARGET_DIR. Move this directory aside and rerun the installer." >&2
  exit 1
fi

if [[ "$MODE" == "--check" ]]; then
  echo "Missing model directory: $TARGET_DIR. Run npm run voice:install first." >&2
  exit 1
fi

mkdir -p "$TARGET_PARENT"
TEMP_DIR="$(mktemp -d "$TARGET_PARENT/.$MODEL_NAME.XXXXXX")"
trap 'rm -rf -- "$TEMP_DIR"' EXIT
ARCHIVE_PATH="$TEMP_DIR/$ARCHIVE_NAME"
echo "Downloading $MODEL_NAME" >&2
curl --fail --location --retry 3 --connect-timeout 15 --max-time 600 \
  --output "$ARCHIVE_PATH" "$ARCHIVE_URL" >&2

ACTUAL_SHA256="$(shasum -a 256 "$ARCHIVE_PATH" | awk '{print $1}')"
if [[ "$ACTUAL_SHA256" != "$ARCHIVE_SHA256" ]]; then
  echo "SHA-256 mismatch for $ARCHIVE_NAME: expected $ARCHIVE_SHA256, got $ACTUAL_SHA256" >&2
  exit 1
fi

tar -xjf "$ARCHIVE_PATH" -C "$TEMP_DIR"
EXTRACTED_DIR="$TEMP_DIR/$MODEL_NAME"
if [[ "$KIND" == "kws" ]]; then
  printf '%s\n' "$WAKE_KEYWORD" > "$EXTRACTED_DIR/keywords.txt"
fi
verify_model "$EXTRACTED_DIR"

# Use the parent as the destination so a concurrent install cannot nest this model.
mkdir "$TEMP_DIR/staged"
STAGED_DIR="$TEMP_DIR/staged/$TARGET_NAME"
mv -- "$EXTRACTED_DIR" "$STAGED_DIR"
mv -n -- "$STAGED_DIR" "$TARGET_PARENT/"
if [[ -e "$STAGED_DIR" ]]; then
  verify_model "$TARGET_DIR"
fi
report_ready
