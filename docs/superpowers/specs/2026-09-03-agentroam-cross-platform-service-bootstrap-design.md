# AgentRoam Cross-Platform Service Bootstrap Design

**Date:** 2026-09-03
**Status:** Approved in conversation; pending written-spec review
**Project:** customer-agent

## Goal

Make the versioned AgentRoam Shell and PowerShell installers the one-time entry point for a usable background installation on macOS arm64 and Windows x64. An installer run verifies or installs the required Node 22 runtime and matching AgentRoam CLI, registers the current-user background service, starts it, verifies readiness, and prints the access URL.

While any AgentRoam runtime is active, including foreground `agentroam start` and the OS-managed service, it prevents idle system sleep but allows the display to turn off normally. Stopping the runtime releases that power assertion.

## User Model

The installers are used only for first installation, version upgrade, or repair:

```text
install-agentroam.sh / install-agentroam.ps1
  -> detect platform and architecture
  -> resolve or install exact Node 22
  -> validate or install exact AgentRoam CLI
  -> register or refresh the current-user service
  -> start the service
  -> verify status and print the URL
```

Routine operation uses the CLI:

```text
agentroam service start
agentroam service stop
agentroam service restart
agentroam service status
agentroam service url
agentroam service logs
agentroam service uninstall
```

`agentroam start` remains the foreground and diagnostic path. It occupies the terminal and exits with the terminal or `Ctrl+C`. The service path returns control to the terminal, survives terminal closure, restarts after failure, and starts again at the next user login.

## Supported Platforms And Non-Goals

- Supported: macOS Apple Silicon and Windows x64, matching the existing managed Node and native runtime packages.
- Services are per-user and require no administrator privileges.
- Linux, WSL, macOS Intel, Windows arm64, pre-login system services, and machine-wide installation are outside this change.
- Idle-sleep prevention does not promise continued operation after lid close, explicit user sleep, hibernation, shutdown, or a low-battery forced sleep.
- The display remains eligible to dim and turn off. AgentRoam never requests a display-sleep assertion.
- The installers do not change global `pmset` or `powercfg` settings.
- This work builds and verifies release artifacts but does not publish them.

## Installer Contract

The existing installers remain versioned and idempotent. They first reuse a valid visible Node 22 or a verified cached private Node `22.22.0`. They then reuse a valid exact-version launcher or install the release's exact AgentRoam package into the versioned private launcher directory. The wrapper is replaced atomically only after `agentroam version` succeeds.

After the wrapper is valid, the installer invokes the selected Node and installed CLI entry point directly to run `service install`. It must not depend on a newly modified `PATH` becoming visible in the current shell. Re-running the installer refreshes absolute Node and CLI paths in the service registration and restarts the service on the installed version.

The service root resolves from `AGENTROAM_ROOT` when set, otherwise from the installer's current working directory. An implicit root equal to the user's home directory is rejected so a copy-pasted installer cannot accidentally expose the full home directory; an explicitly supplied `AGENTROAM_ROOT` may select it. `AGENTROAM_DATA_DIR` continues to control the data directory.

If Node or CLI installation fails, the installer preserves the last verified installation. If service registration, startup, power assertion, or readiness verification fails, the CLI remains installed but the installer exits nonzero with the failed stage and relevant log command. Application data is never deleted by reinstall or repair.

Release verification may set a test-only skip/injection environment variable so isolated bootstrap tests never register or stop the developer's real login service. The production default always registers and starts the service.

## Service Lifecycle

`service install` is idempotent: it writes durable configuration, registers or replaces the OS definition, starts the job, and waits for readiness. It accepts the existing start options. `service start` starts an installed but stopped service using its saved configuration. `service stop` stops and unloads the current job while preserving its registration, configuration, data, and logs. A stopped registered service starts again on the next user login; `service uninstall` is the persistent removal operation.

`service restart` replaces the active process group and waits for a new ready PID. `status`, `url`, and `logs` remain read-only. URL lookup must reject stopped or stale state. A full service restart may allocate a new Quick Tunnel hostname.

### macOS

The existing `com.agentroam.service` user LaunchAgent remains the owner. `RunAtLoad=true` provides login startup and `KeepAlive=true` provides failure restart. `service stop` uses `launchctl bootout` without deleting the plist; `service start` uses `launchctl bootstrap`. No LaunchDaemon or `sudo` is introduced.

### Windows

A current-user Task Scheduler task provides login startup without administrator privileges. Its action uses absolute paths for the selected Node executable and CLI entry point. Task settings allow one active instance and restart the task after unexpected failure. Start, stop, status, restart, and uninstall use structured PowerShell/Task Scheduler APIs rather than shell-built command strings. Service stdout and stderr go to the private AgentRoam log directory.

## Idle-Sleep Inhibition

A focused runtime component acquires the power assertion before starting the Web/PTY gateway or tunnel and holds it for the full runtime lifetime. It applies equally to foreground `start` and service execution.

- macOS requests idle-system-sleep prevention equivalent to `caffeinate -i`. It does not request `caffeinate -d`.
- Windows requests `ES_SYSTEM_REQUIRED` with continuous lifetime semantics. It does not request `ES_DISPLAY_REQUIRED`.
- The assertion is tied to a live process or helper so an abnormal AgentRoam exit cannot leave the machine permanently awake.
- Normal shutdown explicitly releases the assertion. OS process cleanup remains the fallback for crashes.
- Failure to acquire the assertion is a startup failure, because a running process without the promised default sleep behavior would violate the command contract.

No user-facing toggle is added. Running AgentRoam always prevents idle system sleep; stopping it always releases the assertion.

## Security And Data Boundaries

- Service definitions, saved configuration, runtime state, URL files, helper files, and logs remain private to the current user.
- Executable and argument paths are serialized as structured arrays or OS API fields, never concatenated into an unescaped shell command.
- Existing root validation and temporary `_npx` path rejection remain enforced.
- The Windows power helper contains no network or filesystem capability beyond monitoring the AgentRoam parent and holding the OS power request.
- Uninstall removes service control files and active runtime state but preserves accounts, sessions, caches, and logs.

## Verification

Focused tests must cover:

- parsing all service actions, including new `start` and `stop` actions;
- macOS bootstrap/bootout behavior while preserving the plist on stop;
- Windows task registration, start, stop, status, restart, and uninstall through injected command/API runners;
- acquisition and release of macOS idle-sleep and Windows system-required assertions without display assertions;
- assertion cleanup after normal exit, startup failure, and simulated crash/helper exit;
- installer Node/CLI reuse, exact-version repair, service registration, automatic start, root safeguards, and actionable failure output;
- isolated Shell and PowerShell bootstrap tests that cannot touch a real user service;
- full CLI tests, TypeScript checking, tarball audits, and clean installation from newly built artifacts.

A disposable macOS integration check must install, start, stop, restart, and uninstall a temporary service, confirm the display-sleep assertion is absent, and confirm application data survives. Windows CI must execute the corresponding Task Scheduler and power-request lifecycle on a real Windows runner. Static macOS inspection is not accepted as Windows runtime evidence.

## Release Outcome

The build produces aligned launcher and platform artifacts plus both versioned installers and checksums. Release documentation explains that the installer is for install, upgrade, and repair, while routine lifecycle control uses `agentroam service ...`. Publication and production deployment require a separate explicit request.
