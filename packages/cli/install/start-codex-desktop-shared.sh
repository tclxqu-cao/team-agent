#!/usr/bin/env bash
set -euo pipefail

# Launch a stopped official Desktop against the existing shared app-server.
# Restart is opt-in; a normal start preserves an already running Desktop.
codex_desktop_dry_run=false
codex_desktop_restart=false
for codex_desktop_option in "$@"; do
  case "$codex_desktop_option" in
    --dry-run) codex_desktop_dry_run=true ;;
    --restart) codex_desktop_restart=true ;;
    *) echo "Usage: agentroam codex-desktop [--dry-run] [--restart]" >&2; exit 2 ;;
  esac
done

if [[ "$(uname -s)" != Darwin ]]; then
  echo "This launcher requires macOS." >&2
  exit 2
fi

codex_desktop_app="${CODEX_DESKTOP_APP:-}"
if [[ -z "$codex_desktop_app" ]]; then
  if [[ -d /Applications/ChatGPT.app ]]; then
    codex_desktop_app=/Applications/ChatGPT.app
  else
    codex_desktop_app=/Applications/Codex.app
  fi
fi
codex_desktop_name="$(basename "$codex_desktop_app" .app)"
codex_desktop_binary="$codex_desktop_app/Contents/MacOS/$codex_desktop_name"
if [[ ! -x "$codex_desktop_binary" ]]; then
  echo "Official Desktop executable not found: $codex_desktop_binary" >&2
  exit 2
fi

# Attempt the connection regardless of Desktop version. A missing marker in
# app.asar is not proof of incompatibility; the client's actual initialization
# determines whether Desktop, shared or standalone is selected.

codex_shared_root="${CODEX_HOME:-$HOME/.codex}"
codex_shared_socket="$codex_shared_root/app-server-control/app-server-control.sock"
if [[ "$codex_shared_socket" != /* || "$codex_shared_socket" == *[[:space:]%:#?]* ]]; then
  echo "Shared socket path must be absolute and contain no whitespace or URL delimiters." >&2
  exit 2
fi
codex_shared_url="ws+unix://localhost$codex_shared_socket:/rpc"
codex_shared_cli="${AGENT_CODEX_BIN:-$HOME/.local/bin/codex}"
if [[ -n "${AGENT_CODEX_BIN:-}" && ! -x "$codex_shared_cli" ]]; then
  echo "Configured AGENT_CODEX_BIN is not executable: $codex_shared_cli" >&2
  exit 2
fi
if [[ -z "${AGENT_CODEX_BIN:-}" && ! -x "$codex_shared_cli" ]]; then
  codex_shared_cli="$(command -v codex || true)"
fi
if [[ -z "$codex_shared_cli" ]]; then
  echo "Codex CLI not found. Set AGENT_CODEX_BIN to its executable." >&2
  exit 2
fi

codex_desktop_running_pid=""
check_desktop_pid() {
  codex_desktop_running_pid=""
  local codex_desktop_processes
  codex_desktop_processes="$(/bin/ps -axo pid=,args=)" || return 1
  while read -r codex_desktop_pid codex_desktop_command; do
    if [[ "$codex_desktop_command" == "$codex_desktop_binary" || "$codex_desktop_command" == "$codex_desktop_binary "* ]]; then
      if [[ -n "$codex_desktop_running_pid" ]]; then
        echo "Multiple Desktop processes found; no restart attempted." >&2
        return 1
      fi
      codex_desktop_running_pid="$codex_desktop_pid"
    fi
  done <<< "$codex_desktop_processes"
  if [[ -n "${AGENTROAM_CODEX_DESKTOP_EXPECTED_PID:-}" && "${codex_desktop_running_pid:-0}" != "$AGENTROAM_CODEX_DESKTOP_EXPECTED_PID" ]]; then
    echo "Desktop process changed after setup inspection; no restart attempted." >&2
    return 1
  fi
}
check_desktop_pid

if [[ "$codex_desktop_dry_run" == true ]]; then
  echo "Desktop: $codex_desktop_app"
  echo "CODEX_APP_SERVER_WS_URL=$codex_shared_url"
  echo "CLI: $codex_shared_cli"
  if [[ -n "$codex_desktop_running_pid" ]]; then
    if [[ "$codex_desktop_restart" == true ]]; then
      echo "Desktop PID $codex_desktop_running_pid would be quit and relaunched; all its running sessions would be interrupted."
    else
      echo "Desktop PID $codex_desktop_running_pid is running; launch will refuse until Desktop has exited."
    fi
  fi
  echo "Dry run: no process started or stopped, no environment persisted."
  exit 0
fi

if [[ -n "$codex_desktop_running_pid" && "$codex_desktop_restart" != true ]]; then
  echo "Desktop PID $codex_desktop_running_pid is still running. Exit Desktop after its active sessions finish, then rerun, or explicitly use agentroam codex-desktop --restart (interrupts all Desktop sessions)." >&2
  exit 1
fi

# Check daemon availability before asking the existing Desktop to quit.
"$codex_shared_cli" app-server daemon start
if [[ ! -S "$codex_shared_socket" ]]; then
  echo "Shared app-server socket not found: $codex_shared_socket" >&2
  exit 1
fi
"$codex_shared_cli" app-server daemon version >/dev/null

# Recheck after daemon preflight; never quit a different Desktop instance.
codex_desktop_preflight_pid="$codex_desktop_running_pid"
check_desktop_pid
if [[ "$codex_desktop_preflight_pid" != "$codex_desktop_running_pid" ]]; then
  echo "Desktop process changed during daemon preflight; no restart attempted." >&2
  exit 1
fi

if [[ -n "$codex_desktop_running_pid" ]]; then
  if [[ -n "${AGENTROAM_CODEX_DESKTOP_IDLE_GUARD:-}" ]]; then
    "${AGENTROAM_CODEX_DESKTOP_GUARD_NODE:?}" "$AGENTROAM_CODEX_DESKTOP_IDLE_GUARD"
    check_desktop_pid
  fi
  echo "Restarting official Desktop; all its running sessions will be interrupted."
  /usr/bin/osascript \
    -e 'on run argv' \
    -e 'tell application (item 1 of argv) to quit' \
    -e 'end run' "$codex_desktop_app"
  for ((codex_desktop_wait=0; codex_desktop_wait<40; codex_desktop_wait++)); do
    if ! /bin/kill -0 "$codex_desktop_running_pid" 2>/dev/null; then break; fi
    sleep 0.25
  done
  if /bin/kill -0 "$codex_desktop_running_pid" 2>/dev/null; then
    echo "Desktop did not exit; no forced kill or second launch was attempted." >&2
    exit 1
  fi
fi

# open --env applies only to the newly launched app, avoiding global launchd
# environment changes and preserving all Desktop settings and saved windows.
/usr/bin/open -a "$codex_desktop_app" \
  --env "CODEX_APP_SERVER_WS_URL=$codex_shared_url" \
  --env "CODEX_APP_SERVER_FORCE_CLI=0"
echo "Desktop launch requested against $codex_shared_url."
