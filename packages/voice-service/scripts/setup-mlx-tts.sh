#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
RUNTIME_DIR="${VOICE_TTS_RUNTIME_DIR:-$REPO_ROOT/packages/desktop/.agent-data/tts-runtime}"
MODEL="${VOICE_TTS_MODEL:-mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-6bit}"
export HF_HUB_DISABLE_XET="${HF_HUB_DISABLE_XET:-1}"

if ! command -v uv >/dev/null 2>&1; then
  echo "uv is required to install the MLX TTS runtime" >&2
  exit 1
fi

if [[ ! -x "$RUNTIME_DIR/bin/python" ]]; then
  uv venv --python 3.13 "$RUNTIME_DIR"
fi
uv pip install --python "$RUNTIME_DIR/bin/python" "mlx-audio==0.4.8"
"$RUNTIME_DIR/bin/python" -c 'import mlx_audio; print("mlx-audio ready")'

if [[ "${1:-}" == "--download-model" ]]; then
  "$RUNTIME_DIR/bin/python" - "$MODEL" <<'PY'
import sys
from huggingface_hub import snapshot_download

path = snapshot_download(sys.argv[1])
print(f"model ready: {path}")
PY
elif [[ $# -gt 0 ]]; then
  echo "usage: $0 [--download-model]" >&2
  exit 2
fi
