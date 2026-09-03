# AgentRoam macOS LaunchAgent Service Design

**Date:** 2026-09-03
**Status:** Approved
**Project:** customer-agent

## Goal

Allow a globally installed `agentroam` npm CLI to keep the local Web/PTY runtime and public tunnel running after the terminal closes. On macOS, the service starts when the user logs in, restarts after a process failure, exposes the current access URL through a stable file and CLI command, and remains explicitly removable.

The supported installation flow is:

```bash
npm install -g agentroam@preview
agentroam service install
```

The launchd integration is macOS-only. Windows service management is outside this design.

## Process Model

One user LaunchAgent owns the existing foreground CLI process:

```text
launchd: com.agentroam.service
└─ agentroam start
   ├─ Node Web/PTY gateway
   └─ cloudflared, Pinggy SSH, or a custom relay
```

There is one plist and three long-lived OS processes in the default Cloudflare case. The CLI remains the process-group supervisor. If either child exits, the CLI closes the other child and exits; launchd then restarts the whole group. A network interruption that cloudflared handles internally does not restart the process and therefore does not allocate a new Quick Tunnel hostname.

Splitting the Web runtime and tunnel into separate LaunchAgents is rejected because it would duplicate the existing relay orchestration, require a fixed cross-service port contract, and weaken coordinated shutdown and fallback behavior.

## Commands

The CLI adds these commands:

```text
agentroam service install [start options]
agentroam service status
agentroam service url
agentroam service logs
agentroam service restart
agentroam service uninstall
```

`service install` accepts the existing `--root`, `--port`, `--relay`, `--tunnel-command`, `--local-only`, and `--data-dir` options. When no root is supplied, it records the current directory at installation time. QR rendering is disabled for the background service.

`service install` is explicit and idempotent. npm `postinstall` never modifies launchd. An invocation from an npm `_npx` cache is rejected because that package path is temporary. A durable local or global npm installation is accepted, with global installation as the documented path.

`service uninstall` removes the LaunchAgent, service metadata, runtime state, and current URL, while preserving AgentRoam accounts, session data, caches, and logs.

## Files And Permissions

```text
~/Library/LaunchAgents/com.agentroam.service.plist
~/.agentroam/service/config.json
~/.agentroam/service/state.json
~/.agentroam/tunnel.url
~/.agentroam/logs/service.stdout.log
~/.agentroam/logs/service.stderr.log
```

The plist contains absolute paths for the current Node executable and the installed AgentRoam entry point. This avoids dependence on launchd's restricted `PATH`. Re-running `service install` after a Node or npm installation change refreshes those paths and reloads the job.

Configuration, state, URL, and pre-created log files use user-only permissions. Writes to config, state, URL, and plist are atomic. Plist generation goes through macOS `plutil` rather than hand-built XML.

The launchd job sets `AGENTROAM_SERVICE=1`, `RunAtLoad=true`, `KeepAlive=true`, and `ThrottleInterval=5`. It has a fixed working directory equal to the first configured root.

## URL And Runtime State

At service startup, the CLI writes a `starting` state without an access URL so stale tunnel addresses are not reported. After the local runtime and relay are ready, it atomically writes:

```ts
interface ServiceRuntimeState {
  status: "starting" | "ready" | "stopped";
  pid: number;
  version: string;
  startedAt: string;
  updatedAt: string;
  localUrl?: string;
  publicUrl?: string;
  accessUrl?: string;
  provider?: "cloudflare" | "pinggy" | "custom" | "lan";
}
```

The access URL is also written to `tunnel.url`. It may contain the short-lived first-pairing token, so the file is mode `0600` and the URL is not printed into launchd logs. `service install` waits briefly for the ready state and prints the URL to the invoking terminal; `service url` reads it later.

On graceful shutdown the matching process changes its state to `stopped` and removes `tunnel.url`. A newly launched process cannot have its state removed by an older process because cleanup checks the recorded PID.

## launchctl Lifecycle

The service manager addresses the job as `gui/<uid>/com.agentroam.service` and calls `launchctl` with argument arrays, never through a shell.

Installation creates and validates replacement files first, then unloads any prior job, atomically installs the new files, bootstraps the job, and waits for runtime readiness. If bootstrap fails, it reports the exact launchctl error and leaves the validated plist installed for diagnosis. Re-running install repairs and reloads the job.

`restart` uses `launchctl kickstart -k`. `status` combines `launchctl print` with saved config and runtime state. `logs` prints the log paths and recent stdout/stderr content without starting a second daemon. `uninstall` uses `bootout`, treating an absent job as already stopped.

## Failure Behavior

- Non-macOS platforms reject `service` commands with a clear macOS-only message.
- Missing roots, invalid start options, temporary `_npx` paths, `plutil` failures, and launchctl failures stop installation with actionable errors.
- A service that is installed but not running is reported distinctly from an uninstalled service.
- Missing or stale state never causes `service url` to return an old hostname.
- A normal terminal `agentroam start` remains unchanged and continues printing its URL and QR code.
- LaunchAgent means login-time startup, not pre-login system startup. No root privileges or LaunchDaemon are used.

## Verification And Release

Focused tests cover command parsing, start argument serialization, plist conversion inputs, atomic user-only state files, URL cleanup, launchctl status parsing, and all service actions through injected process runners.

The complete CLI test suite and TypeScript build must pass. The npm release verifier installs the generated tarballs into a clean directory and verifies the service command is packaged. A macOS integration check installs a disposable LaunchAgent configuration, verifies the service survives the invoking terminal, checks stable PID and URL state, restarts it, and removes it without deleting application data.

Because `0.2.0-preview.8` already exists on the official registry, publication uses `0.2.0-preview.9`. All launcher and platform package versions, manifests, release documentation, and artifact names remain exactly aligned. Platform packages publish before the launcher, and official registry dist-tags are checked afterward.

After development and packaging verification, rebuild and restart the existing launchd-managed production Web instance on port 3000 using the project release procedure, then verify its health endpoints and stable PID.
