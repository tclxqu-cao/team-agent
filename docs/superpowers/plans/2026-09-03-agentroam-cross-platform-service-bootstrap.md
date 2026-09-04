# AgentRoam Cross-Platform Service Bootstrap Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the versioned macOS and Windows installers validate Node/CLI, register and start a current-user AgentRoam service, and make every running AgentRoam runtime prevent idle system sleep while still allowing display sleep.

**Architecture:** A shared sleep-inhibitor module binds an OS power assertion to each foreground or service runtime. The existing macOS LaunchAgent gains explicit start/stop operations, a new Windows Task Scheduler controller owns a small Node service host, and both bootstrap installers call the installed CLI's idempotent `service install` after validating the exact launcher.

**Tech Stack:** Node.js 22 ESM, TypeScript, Vitest, POSIX Shell, Windows PowerShell 5.1+, macOS launchd/caffeinate, Windows Task Scheduler/SetThreadExecutionState, npm workspaces.

## Global Constraints

- Support macOS Apple Silicon and Windows x64 only; keep Linux, WSL, macOS Intel, and Windows arm64 outside this change.
- Use current-user services without `sudo` or administrator privileges.
- Prevent idle system sleep while AgentRoam runs, but never prevent display dimming or display sleep.
- Do not modify global `pmset` or `powercfg` settings.
- Release power assertions when the runtime stops; abnormal process exit must also release them through OS process cleanup.
- Keep `agentroam start` as the foreground diagnostic path and apply the same idle-sleep behavior to it.
- Keep application data and logs when stopping, reinstalling, repairing, or uninstalling the service.
- Build and verify release artifacts, but do not publish npm packages or deploy the production Web instance.
- Preserve unrelated dirty-worktree changes and modify only the scoped files.

---

### Task 1: Runtime Idle-Sleep Inhibitor

**Files:**
- Create: `packages/cli/src/power/sleep-inhibitor.ts`
- Create: `packages/cli/src/power/sleep-inhibitor.test.ts`
- Modify: `packages/cli/src/cli.ts`

**Interfaces:**
- Produces: `acquireSleepInhibitor(options?: SleepInhibitorOptions): Promise<SleepInhibitor>`.
- Produces: `SleepInhibitor.release(): Promise<void>`.
- Consumes: injected `spawnProcess`, `platform`, and `pid` values for deterministic unit tests.

- [x] **Step 1: Add the focused sleep-inhibitor types**

Define a small lifecycle interface and injected process boundary:

```ts
export interface SleepInhibitor {
  release(): Promise<void>;
}

export interface SleepInhibitorOptions {
  platform?: NodeJS.Platform;
  pid?: number;
  spawnProcess?: typeof spawn;
}
```

- [x] **Step 2: Implement macOS idle-sleep prevention**

Spawn `/usr/bin/caffeinate` with separate arguments `-i`, `-w`, and the AgentRoam PID. Wait for the child `spawn` event, reject if it errors or exits before acquisition, and implement idempotent release by terminating and awaiting the helper. Do not pass `-d`.

- [x] **Step 3: Implement Windows idle-sleep prevention**

Spawn `powershell.exe` with `-NoProfile`, `-NonInteractive`, `-ExecutionPolicy Bypass`, and a UTF-16LE `-EncodedCommand`. The helper calls:

```csharp
SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)
```

It then waits while the parent PID exists and clears to `ES_CONTINUOUS` before exiting. Never include `ES_DISPLAY_REQUIRED`. Treat a false/zero API result or early helper exit as acquisition failure.

- [x] **Step 4: Bind the assertion to the runtime lifecycle**

In `runStart`, acquire the inhibitor before starting the local Web/PTY runtime. Release it in the existing `finally` block after relay/runtime cleanup. `doctor`, `version`, and service management commands must not acquire it.

- [x] **Step 5: Add focused lifecycle tests**

Assert exact macOS arguments, Windows encoded script semantics, absence of display-sleep flags, idempotent release, acquisition failure, and release after `runStart` startup/cleanup paths using injected helpers.

### Task 2: Cross-Platform Service Contract

**Files:**
- Create: `packages/cli/src/service/service-controller.ts`
- Modify: `packages/cli/src/args.ts`
- Modify: `packages/cli/src/args.test.ts`
- Modify: `packages/cli/src/service/service-command.ts`
- Modify: `packages/cli/src/service/service-command.test.ts`
- Modify: `packages/cli/src/service/service-files.ts`

**Interfaces:**
- Produces: `ServiceAction = "install" | "start" | "stop" | "status" | "url" | "logs" | "restart" | "uninstall"`.
- Produces: `ServiceController` with `install`, `start`, `stop`, `status`, `url`, `logs`, `restart`, and `uninstall`.
- Produces: platform-neutral `ServiceStatus.definition` instead of a macOS-only plist field.

- [x] **Step 1: Extend service action parsing**

Accept `service start` and `service stop`. Continue accepting start options only for `service install`; reject trailing options for every lifecycle/read-only action.

- [x] **Step 2: Define the platform-neutral controller interface**

Use shared result types:

```ts
export interface ServiceStatus {
  installed: boolean;
  loaded: boolean;
  running: boolean;
  config: ServiceConfig | null;
  state: ServiceRuntimeState | null;
  definition: string;
}

export interface ServiceController {
  install(config: ServiceConfig): Promise<ServiceInstallResult>;
  start(): Promise<ServiceRuntimeState | null>;
  stop(): Promise<void>;
  status(): Promise<ServiceStatus>;
  url(): Promise<string>;
  logs(maxBytes?: number): Promise<ServiceLogs>;
  restart(): Promise<ServiceRuntimeState | null>;
  uninstall(): Promise<ServiceUninstallResult>;
}
```

- [x] **Step 3: Make service command dispatch platform-aware**

Select `MacLaunchAgent` for `darwin` and `WindowsTaskService` for `win32`; retain an actionable unsupported-platform error elsewhere. Add start/stop output, preserve install/status/url/logs/restart/uninstall behavior, and retain exact Node 22 validation during install.

- [x] **Step 4: Preserve durable file compatibility**

Keep the existing config, state, URL, and log paths. Add only platform-neutral control paths needed by Windows, including a private task-host path if required. Existing macOS installations must remain readable without migration.

- [x] **Step 5: Update parser and command tests**

Cover all eight public service actions, option rejection, platform controller selection, start/stop dispatch, Node validation, and unsupported platforms.

### Task 3: macOS Start/Stop Lifecycle

**Files:**
- Modify: `packages/cli/src/service/macos-launch-agent.ts`
- Modify: `packages/cli/src/service/macos-launch-agent.test.ts`

**Interfaces:**
- Implements: `ServiceController`.
- Produces: `start()` via `launchctl bootstrap` and `stop()` via `launchctl bootout` while preserving the plist and saved configuration.

- [x] **Step 1: Generalize macOS status output**

Return the plist path through `ServiceStatus.definition` and keep installed, loaded, and running distinct.

- [x] **Step 2: Add explicit start behavior**

Reject an uninstalled service. If already loaded and running, return the current ready state. If loaded but not running, use `launchctl kickstart`; if unloaded, use `launchctl bootstrap gui/<uid> <plist>`. Wait for a ready state with a new PID when a previous PID exists.

- [x] **Step 3: Add explicit stop behavior**

Reject an uninstalled service, treat an already unloaded installed service as stopped, otherwise run `launchctl bootout gui/<uid>/com.agentroam.service` and wait for the recorded PID to exit. Do not delete plist, config, data, or logs.

- [x] **Step 4: Reuse start/stop in restart and uninstall**

Keep `kickstart -k` for an active job, bootstrap an unloaded job, and keep uninstall idempotent while deleting only service control/state/URL files.

- [x] **Step 5: Extend macOS controller tests**

Assert installed-stopped start, active start idempotence, explicit stop preservation, status definition, restart PID replacement, and uninstall cleanup.

### Task 4: Windows Task Scheduler Service

**Files:**
- Create: `packages/cli/src/service/windows-task-service.ts`
- Create: `packages/cli/src/service/windows-task-service.test.ts`
- Create: `packages/cli/src/service/windows-service-host.ts`
- Create: `packages/cli/src/service/windows-service-host.test.ts`

**Interfaces:**
- Implements: `ServiceController` as `WindowsTaskService`.
- Produces: `runWindowsServiceHost(configPath: string): Promise<number>`.
- Consumes: `ServiceConfig`, `buildStartArguments`, private service-file helpers, and injected command/process runners.

- [x] **Step 1: Implement the service host**

Read the private saved config, open the configured stdout/stderr log files, and spawn `[config.nodePath, config.cliPath, "start", ...]` with `AGENTROAM_SERVICE=1`, ignored stdin, and log file descriptors. Forward termination, wait for the CLI child, close file handles, and mirror its exit code.

- [x] **Step 2: Implement safe Task Scheduler registration**

Register a current-user logon task named `AgentRoam` through encoded PowerShell using `New-ScheduledTaskAction`, `New-ScheduledTaskTrigger`, `New-ScheduledTaskPrincipal`, `New-ScheduledTaskSettingsSet`, and `Register-ScheduledTask`. The action executes the exact Node path and compiled Windows service host with the private config path. Escape each PowerShell literal and Windows command-line argument deterministically; never pass through `cmd.exe`.

- [x] **Step 3: Implement lifecycle operations**

Use structured PowerShell commands for `Start-ScheduledTask`, `Stop-ScheduledTask`, `Get-ScheduledTask`, `Get-ScheduledTaskInfo`, and `Unregister-ScheduledTask`. Emit machine-readable JSON for status rather than parsing localized table text. Wait for ready/stopped PID state using the same bounded polling behavior as macOS.

- [x] **Step 4: Implement URL, logs, and uninstall**

Apply the same installed/running/ready/stale URL checks as macOS. Read bounded log tails. Uninstall the scheduled task and remove config/state/URL while preserving data and logs.

- [x] **Step 5: Add Windows unit tests**

Assert exact task settings, current-user scope, absolute Node/host/config paths, command-line quoting for spaces and apostrophes, JSON status parsing, every lifecycle action, preserved data/logs, and absence of administrator or global power configuration commands.

### Task 5: Bootstrap Installers Register And Start The Service

**Files:**
- Modify: `packages/cli/install/install-agentroam.sh`
- Modify: `packages/cli/install/install-agentroam.ps1`
- Modify: `packages/cli/install/README.md`
- Modify: `packages/cli/src/install-script-contract.test.ts`
- Modify: `scripts/verify-cli-install.mjs`

**Interfaces:**
- Consumes: exact validated Node executable, launcher entry point, `AGENTROAM_DATA_DIR`, and optional `AGENTROAM_ROOT`.
- Produces: an installed, registered, running service unless the test-only `AGENTROAM_INSTALL_SKIP_SERVICE=1` is set.

- [x] **Step 1: Resolve a safe service root**

Use `AGENTROAM_ROOT` when explicitly set; otherwise use the current working directory. Reject an implicit root equal to `HOME`/`USERPROFILE` with an actionable command showing how to set the intended root. Validate that the root is an existing directory before any service mutation.

- [x] **Step 2: Invoke the installed CLI directly**

After exact launcher validation and atomic wrapper installation, execute the selected Node binary with the versioned launcher entry and:

```text
service install --root <resolved-root> --data-dir <data-dir>
```

Do not depend on shell PATH refresh. Propagate service registration/readiness failures as installer failures while retaining the verified Node and CLI.

- [x] **Step 3: Add an isolated verification escape hatch**

Honor only `AGENTROAM_INSTALL_SKIP_SERVICE=1` in release tests, print that service registration was intentionally skipped, and keep production behavior unchanged when the variable is absent.

- [x] **Step 4: Extend installer contract tests**

Assert service install invocation, explicit and implicit root behavior, home-root rejection, test-only skip behavior, and preservation of existing Node/CLI checksum and atomic-install contracts on both scripts.

- [x] **Step 5: Update clean-install verification**

Set `AGENTROAM_ROOT` to the isolated work directory and `AGENTROAM_INSTALL_SKIP_SERVICE=1` for bootstrap smoke tests. Continue validating private Node `22.22.0` and CLI version, then run separate service parser/controller checks that cannot touch the developer's real service.

### Task 6: Documentation, Packaging, And Release Verification

**Files:**
- Modify: `packages/cli/README.md`
- Modify: `packages/cli/RELEASE.md`
- Modify: `scripts/audit-cli-tarball.mjs` only if new compiled service files are not already covered by the existing `dist/` allowlist
- Generated: `dist/cli-release/*`

**Interfaces:**
- Produces: aligned local release artifacts with both installers and `SHA256SUMS`.
- Consumes: all implementation and focused tests from Tasks 1-5.

- [x] **Step 1: Document installer and routine-command roles**

State that installers are for first install, upgrade, and repair; they default to service registration/start. Document foreground versus service behavior, all service commands, idle-sleep prevention with display sleep allowed, root selection, and forced-sleep limitations.

- [x] **Step 2: Verify package contents**

Confirm the launcher tarball contains compiled sleep-inhibitor, Windows service controller, Windows service host, macOS controller, both installers, and no native helper executable or global power-setting script.

- [x] **Step 3: Build release artifacts**

Run the repository's existing CLI build/collection command under Node 22. Confirm the release directory contains the expected seven aligned tarballs, both installer scripts, and matching checksums with no stale version artifacts.

- [x] **Step 4: Run clean installation checks**

Run the isolated bootstrap verifier and tarball audit. On macOS, run a disposable service lifecycle with a temporary root/data directory, verify `pmset -g assertions` contains an idle-system-sleep assertion attributable to the running AgentRoam process group and no display assertion, then stop/uninstall and confirm the assertion disappears. Leave Windows Task Scheduler and Win32 assertion execution to the Windows CI runner and report that evidence separately.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run:

```bash
bunx vitest run packages/cli/src
bunx tsc -p packages/cli/tsconfig.json --noEmit
node scripts/verify-cli-install.mjs --artifacts dist/cli-release --bootstrap-script
git diff --check
```

Expected: every CLI test passes, TypeScript reports no errors, the isolated bootstrap and clean-install checks pass, and the scoped diff has no whitespace errors. Windows-specific real service and power-request behavior must pass the Windows CI runner before publication; absence of a local Windows host must be reported rather than inferred from macOS tests.

If a test fails, fix the implementation or test and rerun these commands until they pass. Report the commands and results in the final response.
