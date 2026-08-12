#!/usr/bin/env bash
set -euo pipefail

MODEL_NAME="sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01"
ARCHIVE_NAME="${MODEL_NAME}.tar.bz2"
ARCHIVE_SHA256="b2f7c89690dc8ce4c6ed6afeab7cd800c36ad1421fb6b6302b4a4b194cf7f35f"
DEFAULT_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/${ARCHIVE_NAME}"
ARCHIVE_URL="${VOICE_KWS_ARCHIVE_URL:-${DEFAULT_URL}}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TARGET_DIR="${VOICE_KWS_MODEL_DIR:-${REPO_ROOT}/packages/desktop/.agent-data/kws-models/${MODEL_NAME}}"

required_files() {
  local directory="$1"
  [[ -f "${directory}/tokens.txt" ]] \
    && [[ -f "${directory}/keywords.txt" ]] \
    && compgen -G "${directory}/encoder-*.onnx" >/dev/null \
    && compgen -G "${directory}/decoder-*.onnx" >/dev/null \
    && compgen -G "${directory}/joiner-*.onnx" >/dev/null
}

if [[ -e "${TARGET_DIR}" ]]; then
  if required_files "${TARGET_DIR}" \
    && grep -Fxq "x iǎo zh ì @小智" "${TARGET_DIR}/keywords.txt"; then
    echo "${MODEL_NAME} is already installed at ${TARGET_DIR}"
    exit 0
  fi
  echo "Refusing to overwrite incomplete KWS model directory: ${TARGET_DIR}" >&2
  exit 1
fi

mkdir -p "$(dirname "${TARGET_DIR}")"
TEMP_DIR="$(mktemp -d "$(dirname "${TARGET_DIR}")/.${MODEL_NAME}.XXXXXX")"
trap 'rm -rf "${TEMP_DIR}"' EXIT
ARCHIVE_PATH="${TEMP_DIR}/${ARCHIVE_NAME}"

echo "Downloading ${MODEL_NAME}"
curl --fail --location --retry 5 --retry-delay 2 \
  --output "${ARCHIVE_PATH}" \
  "${ARCHIVE_URL}"

ACTUAL_SHA256="$(shasum -a 256 "${ARCHIVE_PATH}" | awk '{print $1}')"
if [[ "${ACTUAL_SHA256}" != "${ARCHIVE_SHA256}" ]]; then
  echo "SHA-256 mismatch: expected ${ARCHIVE_SHA256}, got ${ACTUAL_SHA256}" >&2
  exit 1
fi

tar -xjf "${ARCHIVE_PATH}" -C "${TEMP_DIR}"
EXTRACTED_DIR="${TEMP_DIR}/${MODEL_NAME}"
if ! required_files "${EXTRACTED_DIR}"; then
  echo "Downloaded KWS archive is missing required model files" >&2
  exit 1
fi

printf '%s\n' "x iǎo zh ì @小智" > "${EXTRACTED_DIR}/keywords.txt"
for token in x iǎo zh ì; do
  if ! awk -v expected="${token}" '$1 == expected { found = 1 } END { exit !found }' "${EXTRACTED_DIR}/tokens.txt"; then
    echo "KWS token table does not contain ${token}" >&2
    exit 1
  fi
done

rm "${ARCHIVE_PATH}"
mv "${EXTRACTED_DIR}" "${TARGET_DIR}"
echo "Installed ${MODEL_NAME} at ${TARGET_DIR}"
