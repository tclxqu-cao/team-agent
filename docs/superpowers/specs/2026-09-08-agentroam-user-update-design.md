# AgentRoam User Update And Unsigned Desktop Distribution Design

**Date:** 2026-09-08

## Goal

Notify installed AgentRoam users when a newer stable release is available without delaying startup, session loading, streaming output, or history pagination. A user action starts the download. CLI/WebApp installations then upgrade the versioned launcher and resident service automatically; Desktop users download an unsigned installer from Gitee Release and install it manually.

## Confirmed Decisions

- The CLI, resident WebApp service, and Desktop application use one AgentRoam version.
- The default update channel follows the official npm `agentroam` `latest` dist-tag. Prerelease versions are not offered to normal users.
- Update detection is asynchronous and silent on failure. It never blocks application startup or chat operations.
- A detected release is notification-only. No release bytes are downloaded until the user clicks the update action.
- CLI/WebApp updates are installed automatically after that explicit click.
- Desktop is packaged separately for macOS arm64 and Windows x64 and uploaded to the matching Gitee Release.
- Desktop packages are unsigned in this phase. The app downloads or opens the platform installer but does not silently replace the running Desktop application.
- Gitee Release is the primary binary download surface. npm remains the stable-version discovery and CLI package source.
- Existing session data, pairing state, imported workspaces, managed runtimes, and logs are preserved across updates.

## Current State

AgentRoam currently publishes a universal CLI launcher and six platform packages. Versioned shell and PowerShell installers can perform first installation, repair, and idempotent service replacement while preserving the data directory. The release pipeline publishes npm packages in dependency order, synchronizes installer assets to Gitee, soaks a preview candidate, and promotes all npm `latest` tags only after validation.

The Desktop package is private and has no installer builder, update metadata, or release workflow. There is also no user-facing release checker, cached update state, update API, or updater command.

## Release Contract

### Unified Version

The release-version updater owns the Desktop version in addition to the existing seven npm package versions, manifests, installers, fixtures, and documentation. Drift validation fails when any current release consumer differs.

### Stable Publication Order

A stable version becomes visible to clients only after all required assets are ready:

1. Build and test the seven npm packages.
2. Build the unsigned macOS arm64 and Windows x64 Desktop installers on their native CI runners.
3. Publish the immutable npm candidate and upload CLI installers, Desktop installers, checksums, and the client update manifest to the matching Gitee Release.
4. Download the published assets and verify their exact size and SHA-256 values.
5. Complete the existing preview soak and platform runtime validation.
6. Move every npm package `latest` dist-tag to the candidate as the final availability switch.

Failure before step 6 leaves the previous `latest` release visible to clients. Gitee synchronization or Desktop packaging failure blocks promotion rather than exposing a partially downloadable release.

### Client Update Manifest

Extend the existing audited release manifest with a client-facing section:

```json
{
  "schemaVersion": 2,
  "version": "0.2.1",
  "channel": "latest",
  "publishedAt": "2026-09-08T00:00:00.000Z",
  "installers": {
    "cli": {
      "darwin-arm64": { "fileName": "install-agentroam.sh", "sha256": "..." },
      "windows-amd64": { "fileName": "install-agentroam.ps1", "sha256": "..." }
    },
    "desktop": {
      "darwin-arm64": { "fileName": "AgentRoam-0.2.1-arm64.dmg", "sha256": "...", "signed": false },
      "windows-amd64": { "fileName": "AgentRoam-Setup-0.2.1-x64.exe", "sha256": "...", "signed": false }
    }
  }
}
```

URLs are derived from an allowlisted Gitee owner, repository, release tag, and manifest file name. A manifest cannot redirect the updater to an arbitrary host.

## Asynchronous Detection

### Shared Rules

Pure version parsing, channel selection, manifest validation, and update-state types live in a shared domain module. Server and Desktop adapters own network and storage operations.

Each process exposes an in-memory cached state:

```text
idle -> checking -> up-to-date
                 -> available
                 -> unavailable
```

`unavailable` represents a transient detection failure and is not shown as an application error.

### Timing And Isolation

- Schedule the first check after the application is usable, with a six-to-thirty-second randomized delay.
- Recheck at most once every six hours.
- Coalesce concurrent requests into one in-flight operation.
- Use a short network timeout and conditional HTTP requests with `ETag`/`If-None-Match`.
- Never run detection in session-list, session-detail, message-stream, pagination, project-switch, or input-render paths.
- Do not persist response bodies or registry metadata beyond the validated fields needed for update state.
- Network, parse, and registry failures retain the previous cached result and do not affect runtime health.

### Detection Sequence

1. Read the locally running AgentRoam version.
2. Fetch `https://registry.npmjs.org/agentroam/latest` directly, bypassing user-configured Nexus mirrors.
3. Parse a strict stable SemVer and require it to be greater than the current version.
4. Fetch the versioned `release-manifest.json` from the matching Gitee Release.
5. Require schema, version, channel, supported platform asset, file name, and SHA-256 fields to match the candidate.
6. Publish an `available` state to the UI only after every check passes.

The WebApp reads cached state from a lightweight local API. Desktop reads cached state through a narrow preload IPC contract. Neither renderer performs registry requests directly.

## User Experience

When an update is available, the shared renderer displays a small non-blocking notice containing the target version and an update action. Dismissing the notice hides that version until the next application start; it does not disable future releases.

The initial action is always explicit:

- Before click: no installer or package data has been downloaded.
- During CLI/WebApp update: show download/install progress without blocking unrelated browsing. Explain that the local service will reconnect during activation.
- On CLI/WebApp success: reconnect automatically and show the new running version.
- On Desktop click: start the Gitee installer download using the platform asset URL. The user completes the unsigned operating-system installation manually.
- On Desktop failure: retain the update notice with a retry action.

Unsigned Desktop packages must be described accurately. The UI must not claim that they are verified by Apple or Microsoft, nor promise silent or unattended installation.

## CLI And WebApp Update Execution

### Public Command

Add `agentroam update` as the single supported update entry point. It accepts an optional exact target version for internal/API use but refuses downgrades, prereleases on the stable channel, unknown manifest schemas, unexpected hosts, or mismatched hashes.

### Update Worker

The command creates a durable update-state file and acquires one update lock. It downloads the versioned platform installer only after user initiation, verifies SHA-256, and launches an operating-system-specific helper outside the resident service lifecycle. The helper reuses the existing installer contract:

- install the exact `agentroam@<version>` package graph from the official npm registry into a new version directory;
- validate package versions, native runtime integrity, `doctor`, and the new launcher before activation;
- stop and replace the existing current-user service registration;
- preserve the existing data directory and project roots;
- start the new service and wait for its health endpoint;
- record terminal success or a sanitized failure for the reconnecting UI.

The old launcher and service configuration remain available until the new version passes pre-activation checks. If activation or health validation fails, the helper restores the previous service definition and restarts the previous launcher. Update-state writes are atomic, and stale helpers or locks are recovered with bounded age checks.

### Local API

Expose authenticated same-origin endpoints behind the existing WebApp security boundary:

- `GET /api/update/status`: return cached detection and durable install state immediately.
- `POST /api/update/check`: request a background refresh and return the existing state without waiting on registry I/O.
- `POST /api/update/install`: validate the cached target and start the detached update worker once.

The install endpoint is unavailable when the process is not a supported packaged AgentRoam CLI runtime. It never accepts a URL, package name, shell command, or hash supplied by the renderer.

## Desktop Packaging And Download

Use `electron-builder` to create:

- macOS arm64 DMG for manual installation;
- Windows x64 NSIS installer for manual installation.

Build on native macOS and Windows CI runners so native Electron dependencies match the target ABI. The packaging configuration includes only production renderer/main output, required runtime resources, icons, licenses, and declared application assets. Development caches, `.agent-data`, session databases, repository files, and credentials are excluded by an allowlist audit.

Desktop downloads are mediated by the Electron main process. The renderer can request only the already validated platform asset. The main process uses an allowlisted HTTPS Gitee Release URL and reports progress over IPC. It does not execute the downloaded unsigned installer automatically. The downloaded file is opened or revealed only after its SHA-256 matches the manifest.

## Security Boundary

- npm metadata is read only from `https://registry.npmjs.org`.
- CLI installs use an exact version, never a moving package spec after detection.
- Gitee download URLs are constructed locally from allowlisted coordinates.
- Every downloaded file is checked against the audited manifest before use.
- Release notes and other remote text are not inserted into prompts or rendered as trusted HTML.
- Update endpoints remain protected by the existing local authentication, pairing, origin, and CSRF controls.
- Update logs redact tokens, request headers, environment values, and user paths where practical.
- No update process deletes session, pairing, workspace, runtime-cache, or log directories.

SHA-256 protects artifact consistency but does not give an unsigned Desktop package a trusted publisher identity. That limitation is explicitly accepted for this phase. Signing and in-app Desktop installation are separate future work.

## Failure Handling

- Offline, timeout, malformed metadata, or missing Gitee asset: keep the current release and suppress background errors.
- Unsupported platform: do not offer an install action.
- Concurrent update attempt: return the existing active update state.
- Download or checksum failure: delete only the temporary download and retain the current release.
- CLI pre-activation validation failure: leave the old service untouched.
- CLI activation or health failure: restore and restart the previous service definition.
- WebApp disconnect during an accepted update: reconnect with bounded backoff and recover progress from the durable state file.
- Desktop download failure: leave the application running and allow retry.
- npm `latest` rollback: a client already on the newer version is not automatically downgraded.

## Testing

### Unit And Contract Tests

- strict stable SemVer comparison, prerelease rejection, and downgrade rejection;
- first-check jitter, six-hour cache, ETag handling, request coalescing, timeout, and stale-cache behavior;
- manifest schema, version, platform, host, file-name, and SHA-256 validation;
- API authorization, immediate cached responses, single-worker behavior, and sanitized errors;
- CLI update locking, exact-version install, invalid hash rejection, pre-activation safety, activation rollback, and durable progress;
- Desktop IPC allowlist, download progress, checksum failure, and refusal to auto-execute unsigned installers;
- renderer notice, dismissal, retry, progress, disconnect, and reconnect states;
- release version drift and required-asset gates.

### Platform Verification

- macOS arm64: build the unsigned DMG, inspect its contents, install manually in an isolated user directory, and launch it.
- Windows x64: build the unsigned NSIS installer, inspect its contents, install under a non-administrator user, and launch it.
- Run CLI fresh-install and click-triggered upgrade smoke on both platforms using an isolated data directory.
- Confirm sessions, pairing state, imported workspaces, roots, managed runtimes, and logs survive upgrade.
- Confirm a service restart reconnects the WebApp and reports the new version.
- Confirm update detection adds no calls to session/history endpoints and does not change streaming or pagination event counts.

## Rollout

1. Land detection, APIs, notice UI, and CLI update worker behind a disabled-by-default feature flag.
2. Land native Desktop packaging and Gitee upload without enabling stable notifications.
3. Publish a preview release and run macOS/Windows fresh-install plus previous-version upgrade smoke.
4. Verify the Gitee assets and release manifest from empty caches.
5. Enable preview-channel update checks for maintainers.
6. Promote the verified release to npm `latest` and enable the stable update notice.

## Success Criteria

- Startup, message streaming, project switching, and history pagination remain operational when registry and Gitee requests are slow or unavailable.
- No update bytes are downloaded before a user clicks the update action.
- CLI/WebApp upgrades activate one exact version, reconnect, and preserve all user data.
- Desktop users receive the same version notification and can download the correct unsigned platform installer from Gitee.
- npm `latest` is never advanced when a required CLI or Desktop release asset is missing or unverifiable.
- Release state, client manifest, npm package versions, Gitee tag, and downloadable artifact hashes all trace to one source commit.

## Out Of Scope

- Apple Developer ID signing, notarization, Windows Authenticode, or Trusted Signing.
- Silent Desktop replacement or unattended Desktop restart.
- Automatic downgrade after npm dist-tag rollback.
- User telemetry or fleet-wide update success reporting.
- The separate Windows managed-Codex `rename EPERM` installation defect reported on 2026-09-08.
