#!/bin/sh
set -eu

NODE_VERSION="22.22.0"
MINIMUM_NODE_VERSION="22.22.0"
# Default to the newest published preview; pin an exact version via
# AGENTROAM_VERSION=0.2.0-preview.18 sh install-agentroam.sh
AGENTROAM_VERSION_REQUEST="${AGENTROAM_VERSION:-preview}"
AGENTROAM_VERSION=""
NODE_ARCHIVE="node-v22.22.0-darwin-arm64.tar.xz"
NODE_SHA256="2bd596bbfc4a275ceb8721a5954ee97daea5ebe673e96a185ebd732f6fb023ac"
NODE_URL="https://nodejs.org/dist/v22.22.0/$NODE_ARCHIVE"
NPM_REGISTRY="https://registry.npmjs.org"
DATA_DIR="${AGENTROAM_DATA_DIR:-$HOME/.agentroam}"
NODE_PARENT="$DATA_DIR/runtimes/node"
NODE_ROOT="$NODE_PARENT/$NODE_VERSION"
NODE_LOCK="$NODE_ROOT.lock"
LAUNCHER_PARENT="$DATA_DIR/launcher"
LAUNCHER_ROOT="$LAUNCHER_PARENT/pending-version"
LAUNCHER_LOCK="$LAUNCHER_ROOT.lock"
WRAPPER_DIR="$HOME/.local/bin"
WRAPPER_PATH="$WRAPPER_DIR/agentroam"
if [ "${AGENTROAM_ROOT+x}" = "x" ]; then
  SERVICE_ROOT="$AGENTROAM_ROOT"
else
  SERVICE_ROOT="$PWD"
fi
TEMP_ROOT=""
OWN_NODE_LOCK=0
OWN_LAUNCHER_LOCK=0

fail() {
  printf 'agentroam installer: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [ -n "$TEMP_ROOT" ] && [ -d "$TEMP_ROOT" ]; then
    rm -rf "$TEMP_ROOT"
  fi
  if [ "$OWN_NODE_LOCK" -eq 1 ]; then rmdir "$NODE_LOCK" 2>/dev/null || true; fi
  if [ "$OWN_LAUNCHER_LOCK" -eq 1 ]; then rmdir "$LAUNCHER_LOCK" 2>/dev/null || true; fi
}
trap cleanup EXIT HUP INT TERM

[ "$(uname -s)" = "Darwin" ] || fail "this installer supports macOS only"
[ "$(uname -m)" = "arm64" ] || fail "managed Node.js supports Apple Silicon only"
command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v shasum >/dev/null 2>&1 || fail "shasum is required"
[ -x /usr/bin/tar ] || fail "/usr/bin/tar is required"
[ -d "$SERVICE_ROOT" ] || fail "AgentRoam root is not a directory: $SERVICE_ROOT"
service_root_physical=$(cd "$SERVICE_ROOT" && pwd -P)
SERVICE_ROOT="$service_root_physical"

mkdir -p "$NODE_PARENT" "$LAUNCHER_PARENT" "$WRAPPER_DIR"

version_is_supported() {
  awk -v version="$1" -v minimum="$MINIMUM_NODE_VERSION" 'BEGIN {
    if (version !~ /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/) exit 1;
    sub(/\+.*/, "", version);
    split(version, actual, "."); split(minimum, required, ".");
    for (component = 1; component <= 3; component++) {
      if (actual[component] + 0 > required[component] + 0) exit 0;
      if (actual[component] + 0 < required[component] + 0) exit 1;
    }
    exit 0;
  }'
}

node_is_supported() {
  [ -x "$1" ] && version_is_supported "$("$1" -p 'process.versions.node' 2>/dev/null || true)"
}

find_nvm_node() {
  best_bin=""
  best_major=-1
  best_minor=-1
  best_patch=-1
  for nvm_root in "${NVM_DIR:-}" "$HOME/.nvm"; do
    [ -n "$nvm_root" ] || continue
    for candidate in "$nvm_root"/versions/node/v*/bin/node; do
      [ -x "$candidate" ] || continue
      version=$("$candidate" -p 'process.versions.node' 2>/dev/null || true)
      version_is_supported "$version" || continue
      major=$(printf '%s\n' "$version" | awk -F. '{ print $1 + 0 }')
      minor=$(printf '%s\n' "$version" | awk -F. '{ print $2 + 0 }')
      patch=$(printf '%s\n' "$version" | awk -F. '{ sub(/[^0-9].*$/, "", $3); print $3 + 0 }')
      if [ "$major" -gt "$best_major" ] || { [ "$major" -eq "$best_major" ] && { [ "$minor" -gt "$best_minor" ] || { [ "$minor" -eq "$best_minor" ] && [ "$patch" -gt "$best_patch" ]; }; }; }; then
        best_bin="$candidate"
        best_major=$major
        best_minor=$minor
        best_patch=$patch
      fi
    done
  done
  [ -n "$best_bin" ] && printf '%s\n' "$best_bin"
}

runtime_is_valid() {
  [ -x "$NODE_ROOT/bin/node" ] \
    && [ -f "$NODE_ROOT/lib/node_modules/npm/bin/npm-cli.js" ] \
    && [ "$("$NODE_ROOT/bin/node" --version 2>/dev/null || true)" = "v$NODE_VERSION" ]
}

acquire_directory_lock() {
  lock_path=$1
  waited=0
  while ! mkdir "$lock_path" 2>/dev/null; do
    if [ "$waited" -ge 900 ]; then
      lock_mtime=$(stat -f %m "$lock_path" 2>/dev/null || printf '0')
      now=$(date +%s)
      if [ $((now - lock_mtime)) -gt 900 ]; then
        rmdir "$lock_path" 2>/dev/null || true
        waited=0
        continue
      fi
      fail "timed out waiting for install lock $lock_path"
    fi
    sleep 1
    waited=$((waited + 1))
  done
}

SYSTEM_NODE=$(command -v node 2>/dev/null || true)
if [ "${AGENTROAM_BOOTSTRAP_TEST:-}" = "1" ] && [ "${AGENTROAM_FORCE_PRIVATE_NODE:-}" = "1" ]; then
  SYSTEM_NODE=""
fi
if [ -n "$SYSTEM_NODE" ] && node_is_supported "$SYSTEM_NODE"; then
  NODE_BIN="$SYSTEM_NODE"
else
  if [ "${AGENTROAM_BOOTSTRAP_TEST:-}" = "1" ] && [ "${AGENTROAM_FORCE_PRIVATE_NODE:-}" = "1" ]; then
    NVM_NODE=""
  else
    NVM_NODE=$(find_nvm_node || true)
  fi
  if [ -n "$NVM_NODE" ]; then
    NODE_BIN="$NVM_NODE"
    printf 'Using Node.js %s from NVM: %s\n' "$("$NODE_BIN" --version)" "$NODE_BIN"
  else
    if ! runtime_is_valid; then
      acquire_directory_lock "$NODE_LOCK"
      OWN_NODE_LOCK=1
      if ! runtime_is_valid; then
        TEMP_ROOT=$(mktemp -d "$NODE_PARENT/.node-$NODE_VERSION.XXXXXX")
        archive_path="$TEMP_ROOT/$NODE_ARCHIVE"
        extract_path="$TEMP_ROOT/extract"
        mkdir "$extract_path"
        printf 'Downloading Node.js %s...\n' "$NODE_VERSION"
        if [ -n "${AGENTROAM_NODE_ARCHIVE_FILE:-}" ]; then
          cp "$AGENTROAM_NODE_ARCHIVE_FILE" "$archive_path"
        else
          download_attempt=1
          while ! curl -fL -C - --connect-timeout 15 --max-time 600 "$NODE_URL" -o "$archive_path"; do
            [ "$download_attempt" -lt 3 ] || fail "Node.js download failed after 3 attempts"
            download_attempt=$((download_attempt + 1))
            sleep "$download_attempt"
          done
        fi
        actual_sha=$(shasum -a 256 "$archive_path" | awk '{print $1}')
        [ "$actual_sha" = "$NODE_SHA256" ] || fail "Node.js archive checksum mismatch"
        /usr/bin/tar -xJf "$archive_path" -C "$extract_path"
        entry_count=$(find "$extract_path" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')
        [ "$entry_count" = "1" ] || fail "unexpected Node.js archive layout"
        extracted="$extract_path/node-v$NODE_VERSION-darwin-arm64"
        [ -x "$extracted/bin/node" ] || fail "Node.js executable is missing"
        [ -f "$extracted/lib/node_modules/npm/bin/npm-cli.js" ] || fail "npm CLI is missing"
        [ "$("$extracted/bin/node" --version)" = "v$NODE_VERSION" ] || fail "Node.js version validation failed"
        rm -rf "$NODE_ROOT"
        mv "$extracted" "$NODE_ROOT"
        runtime_is_valid || fail "Node.js activation validation failed"
        rm -rf "$TEMP_ROOT"
        TEMP_ROOT=""
      fi
      rmdir "$NODE_LOCK" 2>/dev/null || true
      OWN_NODE_LOCK=0
    fi
    NODE_BIN="$NODE_ROOT/bin/node"
  fi
fi

if [ "${AGENTROAM_BOOTSTRAP_TEST:-}" = "1" ] && [ "${AGENTROAM_BOOTSTRAP_NODE_DISCOVERY_ONLY:-}" = "1" ]; then
  printf '%s\n' "$NODE_BIN"
  exit 0
fi

find_npm_cli() {
  node_dir=$(dirname "$NODE_BIN")
  for candidate in \
    "$node_dir/../lib/node_modules/npm/bin/npm-cli.js" \
    "$node_dir/lib/node_modules/npm/bin/npm-cli.js"; do
    if [ -f "$candidate" ]; then
      printf '%s\n' "$candidate"
      return
    fi
  done
  fail "npm CLI was not found beside $NODE_BIN"
}

NPM_CLI=$(find_npm_cli)
case "$AGENTROAM_VERSION_REQUEST" in
  *[0-9])
    # Looks like an exact version — honor the pin as-is.
    AGENTROAM_VERSION="$AGENTROAM_VERSION_REQUEST"
    ;;
  *)
    # A dist-tag (default "preview") — resolve to the newest published version
    # so installs always pick up the latest release without touching this file.
    resolved_version="$("$NODE_BIN" "$NPM_CLI" view "agentroam@$AGENTROAM_VERSION_REQUEST" version --registry "$NPM_REGISTRY" 2>/dev/null | tail -1 | tr -d '[:space:]')"
    [ -n "$resolved_version" ] || fail "could not resolve agentroam@$AGENTROAM_VERSION_REQUEST from $NPM_REGISTRY"
    AGENTROAM_VERSION="$resolved_version"
    printf 'Installing AgentRoam %s (resolved from %s)\n' "$AGENTROAM_VERSION" "$AGENTROAM_VERSION_REQUEST"
    ;;
esac
PACKAGE_SPEC="agentroam@$AGENTROAM_VERSION"
LAUNCHER_ROOT="$LAUNCHER_PARENT/$AGENTROAM_VERSION"
LAUNCHER_LOCK="$LAUNCHER_ROOT.lock"
EXTRA_PACKAGE_SPECS=""
if [ "${AGENTROAM_BOOTSTRAP_TEST:-}" = "1" ] && [ -n "${AGENTROAM_PACKAGE_SPEC:-}" ]; then
  PACKAGE_SPEC="$AGENTROAM_PACKAGE_SPEC"
  EXTRA_PACKAGE_SPECS="${AGENTROAM_BOOTSTRAP_EXTRA_SPECS:-}"
fi

launcher_is_valid() {
  [ -f "$LAUNCHER_ROOT/node_modules/agentroam/bin/agentroam.mjs" ] \
    && [ "$("$NODE_BIN" "$LAUNCHER_ROOT/node_modules/agentroam/bin/agentroam.mjs" version 2>/dev/null | awk '{print $2}' || true)" = "$AGENTROAM_VERSION" ]
}

if ! launcher_is_valid; then
  acquire_directory_lock "$LAUNCHER_LOCK"
  OWN_LAUNCHER_LOCK=1
  if ! launcher_is_valid; then
    TEMP_ROOT=$(mktemp -d "$LAUNCHER_PARENT/.launcher-$AGENTROAM_VERSION.XXXXXX")
    # Test-only extra specs are whitespace-delimited artifact paths in isolated CI directories.
    # shellcheck disable=SC2086
    "$NODE_BIN" "$NPM_CLI" install --no-audit --no-fund --registry "$NPM_REGISTRY" --prefix "$TEMP_ROOT" $EXTRA_PACKAGE_SPECS "$PACKAGE_SPEC"
    entry="$TEMP_ROOT/node_modules/agentroam/bin/agentroam.mjs"
    [ -f "$entry" ] || fail "AgentRoam launcher is missing after npm install"
    [ "$("$NODE_BIN" "$entry" version | awk '{print $2}')" = "$AGENTROAM_VERSION" ] || fail "AgentRoam version validation failed"
    rm -rf "$LAUNCHER_ROOT"
    mv "$TEMP_ROOT" "$LAUNCHER_ROOT"
    TEMP_ROOT=""
  fi
  rmdir "$LAUNCHER_LOCK" 2>/dev/null || true
  OWN_LAUNCHER_LOCK=0
fi

entry="$LAUNCHER_ROOT/node_modules/agentroam/bin/agentroam.mjs"
wrapper_temp=$(mktemp "$WRAPPER_DIR/.agentroam.XXXXXX")
{
  printf '#!/bin/sh\n'
  printf 'exec "%s" "%s" "$@"\n' "$NODE_BIN" "$entry"
} > "$wrapper_temp"
chmod 755 "$wrapper_temp"
mv "$wrapper_temp" "$WRAPPER_PATH"

if ! "$NODE_BIN" "$entry" doctor --data-dir "$DATA_DIR"; then
  printf 'Warning: some component checks failed; continuing background service installation. Affected features may be unavailable. Run agentroam doctor to retry.\n' >&2
fi
if [ "${AGENTROAM_INSTALL_SKIP_SERVICE:-}" = "1" ]; then
  printf 'AgentRoam service registration skipped for isolated verification.\n'
else
  "$NODE_BIN" "$entry" service install --root "$SERVICE_ROOT" --data-dir "$DATA_DIR"
fi
printf '\nAgentRoam %s installed: %s\n' "$AGENTROAM_VERSION" "$WRAPPER_PATH"
case ":${PATH:-}:" in
  *":$WRAPPER_DIR:"*) ;;
  *) printf 'Add this directory to PATH: export PATH="%s:$PATH"\n' "$WRAPPER_DIR" ;;
esac

# stdin is the script itself when launched with curl | sh. Read the choice
# from the controlling terminal instead; unattended installs never block.
desktop_choice="${AGENTROAM_INSTALL_DESKTOP:-ask}"
if [ "${AGENTROAM_INSTALL_SKIP_SERVICE:-}" = "1" ] && [ "$desktop_choice" = "ask" ]; then desktop_choice=no; fi
if [ "$desktop_choice" = "ask" ]; then
  desktop_choice=no
  if ( : </dev/tty ) 2>/dev/null; then
    printf '\n是否下载桌面端？用于手机查看和控制电脑桌面 [y/N]：' >/dev/tty
    IFS= read -r desktop_choice </dev/tty || desktop_choice=no
  fi
fi
case "$desktop_choice" in
  y|Y|yes|YES|是)
    desktop_helper="$LAUNCHER_ROOT/node_modules/agentroam/bin/desktop-download.mjs"
    if [ -f "$desktop_helper" ]; then
      "$NODE_BIN" "$desktop_helper" "$AGENTROAM_VERSION" || printf 'CLI 安装已完成，桌面端可稍后重新下载。\n'
    else
      printf '当前发布的 CLI 尚未包含桌面下载功能，请在新版发布后重试。CLI 安装已完成。\n'
    fi
    ;;
  *) printf '已跳过桌面端下载，CLI 可正常使用。\n' ;;
esac
