#!/usr/bin/env bash
set -euo pipefail
exec bash "$(dirname "$0")/../packages/cli/install/start-codex-desktop-shared.sh" "$@"
