#!/bin/bash
# Copied to a stable private directory: upgrades must not invalidate this job.
set -euo pipefail
codex_bin="$1"
codex_home="$2"
shared_url="$3"
export CODEX_HOME="$codex_home"
export PATH="$4"
export CODEX_APP_SERVER_FORCE_CLI=0
export CODEX_APP_SERVER_WS_URL="$shared_url"
/bin/launchctl setenv CODEX_APP_SERVER_WS_URL "$shared_url"
/bin/launchctl setenv CODEX_APP_SERVER_FORCE_CLI 0
/bin/launchctl setenv CODEX_HOME "$codex_home"
# daemon start is idempotent; never stop or replace a live daemon.
cd "$5"
exec "$codex_bin" app-server daemon start
