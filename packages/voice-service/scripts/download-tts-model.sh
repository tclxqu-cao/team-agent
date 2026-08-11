#!/usr/bin/env bash
set -euo pipefail

MODEL_NAME="vits-melo-tts-zh_en"
BASE_URL="${VOICE_MODEL_MIRROR:-https://hf-mirror.com}/csukuangfj/${MODEL_NAME}/resolve/main"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TARGET_DIR="${VOICE_TTS_MODEL_DIR:-${REPO_ROOT}/packages/desktop/.agent-data/tts-models/${MODEL_NAME}}"

FILES=(
  LICENSE
  README.md
  date.fst
  lexicon.txt
  model.onnx
  new_heteronym.fst
  number.fst
  phone.fst
  tokens.txt
  dict/README.md
  dict/hmm_model.utf8
  dict/idf.utf8
  dict/jieba.dict.utf8
  dict/stop_words.utf8
  dict/user.dict.utf8
  dict/pos_dict/char_state_tab.utf8
  dict/pos_dict/prob_emit.utf8
  dict/pos_dict/prob_start.utf8
  dict/pos_dict/prob_trans.utf8
)

mkdir -p "${TARGET_DIR}/dict/pos_dict"
for file in "${FILES[@]}"; do
  echo "Downloading ${file}"
  curl --fail --location --retry 5 --retry-delay 2 \
    --output "${TARGET_DIR}/${file}" \
    "${BASE_URL}/${file}"
done

verify_sha256() {
  local expected="$1"
  local file="$2"
  local actual
  actual="$(shasum -a 256 "${file}" | awk '{print $1}')"
  if [[ "${actual}" != "${expected}" ]]; then
    echo "SHA-256 mismatch for ${file}: expected ${expected}, got ${actual}" >&2
    exit 1
  fi
}

verify_sha256 \
  "bf30582eb1b012250a35b1a4a80e7dfbcf8485e7bb9de0d95efbbeef0e4ad86d" \
  "${TARGET_DIR}/model.onnx"
verify_sha256 \
  "d18664a7e12bd7ea1022ddaf951e534e136815016c5a809d6b64156bffb4369d" \
  "${TARGET_DIR}/tokens.txt"
verify_sha256 \
  "7236884b02435ac5d10cf69b4be40a61b45aa676b5300f0e412f185748fee528" \
  "${TARGET_DIR}/lexicon.txt"

echo "Installed ${MODEL_NAME} at ${TARGET_DIR}"
