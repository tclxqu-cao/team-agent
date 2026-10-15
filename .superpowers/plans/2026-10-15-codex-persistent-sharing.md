# Codex persistent sharing implementation plan

> **For the main agent:** Implement directly in this session. Do not dispatch subagents. Run affected tests after implementation.

Goal: Persist normal-icon shared startup, recover the daemon after login/failure, and report actual Desktop and AgentRoam connections with a safe repair action.
Architecture: A private, stable watchdog shell file and RunAtLoad/StartInterval LaunchAgent maintain the GUI environment and idempotently start the native daemon. A read-only CLI probe verifies RPC plus Unix socket ownership. The server invokes this CLI using fixed argument arrays; UI combines it with actual runtime transport.
Constraints: macOS Desktop integration; no official app modification; no forced restarts or lock removal; retain unrelated work; dry-run/status must not write; no project docs changes or Git operations.

- [x] CLI watchdog/configuration: writePrivateText for stable script, plist conversion and bootstrap; update only this job; synchronous environment + daemon start; startup/service/setup callers persist defaults even if Desktop stays running.
- [x] CLI status/repair: add mutually exclusive --status/--repair; return JSON; inspect Desktop process and private children, resolve socket symlink, match Desktop socket peers to daemon listener descriptors; verify read-only config/read RPC; failures cannot report shared.
- [x] Runtime health: include actual client connection mode and live read probe for dedicated sharing endpoint. Preserve generic health contract.
- [x] Server API/UI: fixed CLI path from gateway configuration with repository fallback; bounded execFile; no client supplied paths; no-store GET/POST; same-origin writes; menu status, refresh and repair action with honest independent/stopped/error states.
- [x] Ownership: retain first timestamp for identical debounce samples; test repeated sub-debounce polls and reset on actual sample change.
- [x] Verification: CLI and focused native/server/UI tests; CLI build and pack manifest; isolated Next/native build; verify actual configured job/RPC/socket status; deploy using active-run guard and rollback, preserving daemon/Desktop.

Validation: 295 focused tests passed before final additions; 19 API/status tests and 9 watchdog tests passed after hardening. CLI build/pack manifest and final native/Next build passed. Isolated launchd recovery killed only a test daemon (23989 -> 24205), then verified config/read. Live 3000 rollout is tracked by /tmp/agentroam-release-sharing-20261015-140641/backend-status.json; login/logout acceptance remains untested.
