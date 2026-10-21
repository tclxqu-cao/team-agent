#!/bin/sh
set -eu

NODE_VERSION="22.22.0"
MINIMUM_NODE_VERSION="22.22.0"
# Default to the newest published preview (npm dist-tag); pin an exact version via
# AGENTROAM_VERSION=<x.y.z-preview.N> sh install-agentroam.sh
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
PREVIOUS_LAUNCHER_ROOT=""
OWN_NODE_LOCK=0
OWN_LAUNCHER_LOCK=0
PROGRESS_PID=""

# Works before Node exists and never reads stdin (curl | sh owns it).
stop_progress() {
  if [ -n "$PROGRESS_PID" ]; then
    kill "$PROGRESS_PID" 2>/dev/null || true
    wait "$PROGRESS_PID" 2>/dev/null || true
    PROGRESS_PID=""
  fi
}

start_progress() {
  stop_progress
  [ "${AGENTROAM_NO_PROGRESS:-}" != "1" ] || return 0
  printf '… %s (elapsed 0s)\n' "$1" >&2
  (
    progress_label=$1
    progress_started=$(date +%s)
    progress_sleep_pid=""
    trap 'if [ -n "$progress_sleep_pid" ]; then kill "$progress_sleep_pid" 2>/dev/null || true; wait "$progress_sleep_pid" 2>/dev/null || true; fi' EXIT
    trap 'exit 0' HUP INT TERM
    while :; do
      sleep 5 &
      progress_sleep_pid=$!
      wait "$progress_sleep_pid" || exit 0
      progress_sleep_pid=""
      progress_now=$(date +%s)
      printf '… %s (elapsed %ss)\n' "$progress_label" "$((progress_now - progress_started))" >&2
    done
  ) </dev/null &
  PROGRESS_PID=$!
}

run_with_progress() {
  progress_command_label=$1
  shift
  start_progress "$progress_command_label"
  if "$@"; then progress_command_status=0; else progress_command_status=$?; fi
  stop_progress
  return "$progress_command_status"
}

fail() {
  printf 'agentroam installer: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  stop_progress
  if [ -n "$PREVIOUS_LAUNCHER_ROOT" ] && [ -d "$PREVIOUS_LAUNCHER_ROOT" ] && [ ! -e "$LAUNCHER_ROOT" ]; then
    mv "$PREVIOUS_LAUNCHER_ROOT" "$LAUNCHER_ROOT" || printf 'Could not restore previous launcher: %s\n' "$PREVIOUS_LAUNCHER_ROOT" >&2
  fi
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

start_progress "Checking available Node.js"
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
      start_progress "Waiting for the Node.js installation lock"
      acquire_directory_lock "$NODE_LOCK"
      stop_progress
      OWN_NODE_LOCK=1
      if ! runtime_is_valid; then
        TEMP_ROOT=$(mktemp -d "$NODE_PARENT/.node-$NODE_VERSION.XXXXXX")
        archive_path="$TEMP_ROOT/$NODE_ARCHIVE"
        extract_path="$TEMP_ROOT/extract"
        mkdir "$extract_path"
        printf 'Downloading Node.js %s...\n' "$NODE_VERSION"
        start_progress "Downloading Node.js $NODE_VERSION"
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
        start_progress "Verifying the Node.js archive"
        actual_sha=$(shasum -a 256 "$archive_path" | awk '{print $1}')
        [ "$actual_sha" = "$NODE_SHA256" ] || fail "Node.js archive checksum mismatch"
        start_progress "Extracting and verifying Node.js"
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
stop_progress

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
    start_progress "Resolving AgentRoam $AGENTROAM_VERSION_REQUEST version"
    resolved_version="$("$NODE_BIN" "$NPM_CLI" view "agentroam@$AGENTROAM_VERSION_REQUEST" version --registry "$NPM_REGISTRY" 2>/dev/null | tail -1 | tr -d '[:space:]')"
    stop_progress
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

LAUNCHER_CHECK_JS='
const { readFileSync, statSync } = require("node:fs");
const { createHash } = require("node:crypto");
const { createRequire } = require("node:module");
const { dirname, resolve, sep } = require("node:path");
const [prefix, launcherVersion, minimumNodeVersion, target, mode] = process.argv.slice(process.argv[1] === "-" ? 2 : 1);
try {
  const packageName = {
    "darwin-arm64": "agentroam-runtime-darwin-arm64",
    "windows-amd64": "agentroam-runtime-win32-x64",
  }[target];
  if (!packageName) throw new Error("Unsupported runtime target: " + target);
  const launcherPath = resolve(prefix, "node_modules/agentroam/package.json");
  const launcher = JSON.parse(readFileSync(launcherPath, "utf8"));
  if (launcher.version !== launcherVersion) throw new Error("AgentRoam launcher version mismatch");
  const version = launcher.optionalDependencies?.[packageName];
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("Runtime dependency must use an exact version: " + packageName);
  }
  if (mode === "spec") {
    console.log(packageName + "@" + version);
  } else {
    if (mode !== "verify") throw new Error("Unknown runtime validation mode: " + mode);
    const launcherRequire = createRequire(launcherPath);
    const manifestPath = launcherRequire.resolve(packageName + "/manifest.json");
    const runtimeRoot = dirname(launcherRequire.resolve(packageName + "/runtime"));
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const runtimePackage = JSON.parse(readFileSync(resolve(dirname(manifestPath), "package.json"), "utf8"));
    if (runtimePackage.name !== packageName || runtimePackage.version !== version ||
        manifest.packageVersion !== version || manifest.target !== target ||
        manifest.schemaVersion !== 2 || manifest.minimumNodeVersion !== minimumNodeVersion ||
        !manifest.nativeFiles || typeof manifest.nativeFiles !== "object" || Array.isArray(manifest.nativeFiles)) {
      throw new Error("Invalid runtime manifest: " + manifestPath);
    }
    const nativeTarget = target === "darwin-arm64" ? "darwin-arm64" : "win32-x64";
    for (const file of [
      "node_modules/better-sqlite3/prebuilds/" + nativeTarget + ".node",
      "node_modules/node-pty/prebuilds/" + nativeTarget + "/pty.node",
      ...(target === "darwin-arm64"
        ? ["node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper"]
        : ["node_modules/node-pty/prebuilds/win32-x64/conpty.node",
          "node_modules/node-pty/prebuilds/win32-x64/conpty/conpty.dll",
          "node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe"]),
    ]) {
      if (!manifest.nativeFiles[file]) throw new Error("Missing runtime native inventory: " + file);
    }
    for (const file of ["bin/agentroam.mjs"]) {
      if (!statSync(resolve(dirname(launcherPath), file)).isFile()) throw new Error("Missing launcher file: " + file);
    }
    for (const file of ["ws-server.mjs", ".next/BUILD_ID"]) {
      if (!statSync(resolve(runtimeRoot, file)).isFile()) throw new Error("Missing runtime file: " + file);
    }
    for (const [file, expectedHash] of Object.entries(manifest.nativeFiles)) {
      const path = resolve(runtimeRoot, file);
      if (!path.startsWith(runtimeRoot + sep) || !/^[a-f0-9]{64}$/.test(expectedHash)) {
        throw new Error("Invalid runtime native inventory: " + file);
      }
      const actualHash = createHash("sha256").update(readFileSync(path)).digest("hex");
      if (actualHash !== expectedHash) throw new Error("Runtime native file checksum mismatch: " + file);
    }
    const runtimeRequire = createRequire(resolve(runtimeRoot, "package.json"));
    for (const name of ["better-sqlite3", "node-pty"]) {
      if (!runtimeRequire.resolve(name).startsWith(runtimeRoot + sep)) throw new Error("Missing runtime module: " + name);
    }
    const Database = runtimeRequire("better-sqlite3");
    const database = new Database(":memory:");
    try {
      if (database.prepare("SELECT 1 AS ok").get()?.ok !== 1) throw new Error("SQLite runtime query failed");
    } finally {
      database.close();
    }
    if (typeof runtimeRequire("node-pty").spawn !== "function") throw new Error("Invalid PTY runtime module");
  }
} catch (error) {
  console.error("AgentRoam runtime validation failed: " + error.message);
  process.exitCode = 1;
}
'

launcher_check() {
  "$NODE_BIN" -e "$LAUNCHER_CHECK_JS" "$1" "$AGENTROAM_VERSION" "$MINIMUM_NODE_VERSION" darwin-arm64 "$2"
}

launcher_is_valid() {
  launcher_check "$LAUNCHER_ROOT" verify >/dev/null 2>&1
}

start_progress "Checking the installed CLI"
if ! launcher_is_valid; then
  start_progress "Waiting for the CLI installation lock"
  acquire_directory_lock "$LAUNCHER_LOCK"
  stop_progress
  OWN_LAUNCHER_LOCK=1
  if ! launcher_is_valid; then
    TEMP_ROOT=$(mktemp -d "$LAUNCHER_PARENT/.launcher-$AGENTROAM_VERSION.XXXXXX")
    # Test-only extra specs are whitespace-delimited artifact paths in isolated CI directories.
    # shellcheck disable=SC2086
    run_with_progress "Downloading and installing CLI and platform components" "$NODE_BIN" "$NPM_CLI" install --no-audit --no-fund --registry "$NPM_REGISTRY" --prefix "$TEMP_ROOT" $EXTRA_PACKAGE_SPECS "$PACKAGE_SPEC"
    runtime_spec=$(launcher_check "$TEMP_ROOT" spec)
    if ! launcher_check "$TEMP_ROOT" verify; then
      # A matching runtime is required even though npm treats platform packages as optional.
      rm -rf "$TEMP_ROOT/node_modules/agentroam-runtime-darwin-arm64"
      run_with_progress "Installing required runtime components" "$NODE_BIN" "$NPM_CLI" install --save-exact --include=optional --no-audit --no-fund --registry "$NPM_REGISTRY" --prefix "$TEMP_ROOT" "$runtime_spec"
    fi
    run_with_progress "Verifying runtime components" launcher_check "$TEMP_ROOT" verify
    start_progress "Verifying and activating CLI"
    if [ -e "$LAUNCHER_ROOT" ]; then
      PREVIOUS_LAUNCHER_ROOT=$(mktemp -d "$LAUNCHER_PARENT/.previous-$AGENTROAM_VERSION.XXXXXX")
      rmdir "$PREVIOUS_LAUNCHER_ROOT"
      mv "$LAUNCHER_ROOT" "$PREVIOUS_LAUNCHER_ROOT"
    fi
    if ! mv "$TEMP_ROOT" "$LAUNCHER_ROOT"; then fail "could not activate AgentRoam launcher"; fi
    TEMP_ROOT=""
    if [ -n "$PREVIOUS_LAUNCHER_ROOT" ]; then rm -rf "$PREVIOUS_LAUNCHER_ROOT"; fi
    PREVIOUS_LAUNCHER_ROOT=""
  fi
  rmdir "$LAUNCHER_LOCK" 2>/dev/null || true
  OWN_LAUNCHER_LOCK=0
fi
stop_progress

entry="$LAUNCHER_ROOT/node_modules/agentroam/bin/agentroam.mjs"
wrapper_temp=$(mktemp "$WRAPPER_DIR/.agentroam.XXXXXX")
{
  printf '#!/bin/sh\n'
  printf 'exec "%s" "%s" "$@"\n' "$NODE_BIN" "$entry"
} > "$wrapper_temp"
chmod 755 "$wrapper_temp"
mv "$wrapper_temp" "$WRAPPER_PATH"

if ! run_with_progress "Checking runtime components" env AGENTROAM_NO_PROGRESS=1 "$NODE_BIN" "$entry" doctor --data-dir "$DATA_DIR"; then
  printf 'Warning: some component checks failed; continuing background service installation. Affected features may be unavailable. Run agentroam doctor to retry.\n' >&2
fi
if [ "${AGENTROAM_INSTALL_SKIP_SERVICE:-}" = "1" ]; then
  printf 'AgentRoam service registration skipped for isolated verification.\n'
else
  # The CLI owns progress here so it can pause for confirmations and print QR intact.
  printf '… Installing background service; remote desktop authorization and phone pairing follow\n' >&2
  codex_setup_module="$(dirname "$entry")/../dist/codex-desktop-setup.js"
  install_background_service() {
    if [ -f "$codex_setup_module" ]; then
      "$NODE_BIN" "$entry" service install --root "$SERVICE_ROOT" --data-dir "$DATA_DIR" --setup-codex-desktop
    else
      printf 'This CLI does not include Codex Desktop sharing setup yet. You can connect to AgentRoam, but existing desktop sessions are not shared. Upgrade the CLI and retry.\n'
      "$NODE_BIN" "$entry" service install --root "$SERVICE_ROOT" --data-dir "$DATA_DIR"
    fi
  }
  if ! install_background_service; then
    printf 'CLI installed, but the background service failed to start. Run agentroam service logs, fix the error, then run agentroam service start and agentroam pair.\n' >&2
    exit 1
  fi
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
    printf '\nDownload the desktop app for remote viewing and control? [y/N]: ' >/dev/tty
    IFS= read -r desktop_choice </dev/tty || desktop_choice=no
  fi
fi
case "$desktop_choice" in
  y|Y|yes|YES|是)
    desktop_helper="$LAUNCHER_ROOT/node_modules/agentroam/bin/desktop-download.mjs"
    if [ -f "$desktop_helper" ]; then
      run_with_progress "Downloading and verifying the desktop installer" env AGENTROAM_NO_PROGRESS=1 "$NODE_BIN" "$desktop_helper" "$AGENTROAM_VERSION" || printf 'CLI installation completed. You can retry the desktop download later.\n'
    else
      printf 'This CLI version does not support desktop downloads. CLI installation completed; upgrade to retry.\n'
    fi
    ;;
  *) printf 'Desktop download skipped. CLI is ready to use.\n' ;;
esac
