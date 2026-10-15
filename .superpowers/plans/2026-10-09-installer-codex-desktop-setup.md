# Installer Codex Desktop Setup Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox syntax for tracking.

**Goal:** Handle official Codex Desktop sharing before printing the installer's pairing QR.

**Architecture:** The macOS installer opts into a service-install setup hook. A read-only probe of a verified Desktop-owned listener enumerates all loaded threads and reads their runtime status; private stdio or incomplete queries return unknown. A stopped Desktop starts, an observed idle Desktop restarts after a second check, and busy/unknown Desktop requires a controlling-terminal `y`. Existing explicit restart remains available.

**Tech Stack:** POSIX shell, TypeScript, Node 22, undici WebSocket, Vitest.

## Global Constraints

- User replaces the previous installation default with idle automatic restart and busy confirmation.
- Never treat one idle session, writer locks, historical rollout files, or another daemon's empty thread list as global Desktop idle.
- Missing `/dev/tty`, refusal, probe failure, and launch failure preserve installation and report limited sharing before pairing.
- Do not infer unsupported Desktop from version numbers or an absent archive marker. Attempt Desktop connection; the runtime selects desktop, shared, then standalone according to actual handshake/initialization results.
- The installer handles old published launchers without passing unsupported flags.
- This task does not restart the actual Desktop, deploy, publish, commit, push, or change project docs.

### Task 1: Read-only Desktop inspection

**Files:** Create `packages/cli/src/codex-desktop-status.ts`, `codex-desktop-probe.ts`, and focused tests.

**Interfaces:** `inspectCodexDesktop(environment): Promise<DesktopSnapshot>` and `probeDesktopActivity(endpoint): Promise<DesktopActivity>`.

- [x] Detect the installed official app and running process without a version or archive-marker rejection gate.
- [x] Verify every direct app-server child's local listener ownership; stdio, missing listener, and partial results remain unknown.
- [x] Use initialize, thread/loaded/list pagination, thread/read metadata, and a second loaded-thread scan. Query failures, unknown statuses, and concurrent activity fail closed.

### Task 2: Setup decision and terminal confirmation

**Files:** Create `packages/cli/src/codex-desktop-setup.ts`; update command launcher and packaged script.

**Interfaces:** `setupCodexDesktop(options, context): Promise<void>` runs before pairing; context permits deterministic inspector/launcher/confirmation tests.

- [x] Start stopped Desktop; restart only a rechecked idle Desktop or explicit controlling-terminal `y`.
- [x] Read confirmation from `/dev/tty`, including curl-piped installs; default to preservation on missing terminal or empty/no response.
- [x] Recheck app PID; pass the expected PID to the launcher and revalidate it before quit. Preserve daemon readiness preflight and the final idle guard.

### Task 3: Installer wiring and pairing order

**Files:** Modify installer, args, CLI help, service command, and their affected tests.

- [x] Add `service install --setup-codex-desktop` and `codex-desktop --setup`.
- [x] Installer checks the packaged setup module before passing the opt-in flag; an older launcher uses its existing install command with a compatibility notice.
- [x] Run setup before any pairing QR, then generate a fresh pairing code. Catch setup failures without masking service installation failure.

## Final Unit Test Verification

- [x] Run affected CLI tests after development, then CLI TypeScript build and npm pack dry run.
- [x] Validate packaged shell syntax and execute only read-only actual Desktop inspection/dry run.
- [x] Stage reusable findings in wiki `_raw/`; suggest project docs sync without editing docs.

## Verification Results

- CLI tests: 85 passed, 1 Windows-specific test skipped across args, Desktop command/probe/status/setup, service command, and installer contract files.
- Exact test command: `/opt/homebrew/opt/node@22/bin/node node_modules/vitest/vitest.mjs run packages/cli/src/args.test.ts packages/cli/src/codex-desktop-command.test.ts packages/cli/src/codex-desktop-probe.test.ts packages/cli/src/codex-desktop-status.test.ts packages/cli/src/codex-desktop-setup.test.ts packages/cli/src/service/service-command.test.ts packages/cli/src/install-script-contract.test.ts`. Log: `/tmp/agentroam-installer-codex-final-tests.log`.
- CLI TypeScript build: PASS. npm pack dry run includes setup, probe, status, idle guard, and packaged launcher/installer.
- Actual controlling-terminal PTY tests: y, empty line, n, and no controlling terminal all PASS; piped stdin never acts as restart authorization.
- Actual Desktop read-only inspection: PID 30745, private backend, unknown activity. No Desktop restart or business RPC was performed.
- No project docs changes, commit, push, npm publication or service deployment. Findings staged in wiki `_raw/2026-10-09-agentroam-installer-desktop-setup.md`.

## Revision: Attempt Desktop without a version gate

- Removed archive/variable-marker rejection from Desktop inspection and the packaged launcher. No historical Desktop version cutoff was verified.
- Missing marker or archive now still attempts restart after existing task/identity checks. Explicit refusal, unknown-task confirmation, daemon preflight and the last idle guard remain in effect.
- Native startup chooses desktop, shared, then standalone by actual handshake/initialize success; business messages are never replayed across backends.
- Verification: 113 passed and 1 skipped across the seven CLI test files above plus `packages/native-runtime/src/agent-runtime/codex-app-server-client.test.ts` and `codex-app-server-desktop.test.ts`; log `/tmp/agentroam-desktop-no-version-gate-tests.log`. CLI build, bash syntax and diff check passed. Actual Desktop inspection remained read-only.
