# AgentRoam User Update Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add non-blocking stable update detection, click-triggered CLI/WebApp upgrades, click-triggered unsigned Desktop installer downloads, and a release pipeline that publishes the matching artifacts to Gitee.

**Architecture:** A framework-free update domain validates stable versions and release manifests, while Server and Electron adapters own networking, caching, persistence, process execution, and IPC. The shared renderer consumes one narrow update API and shows a non-blocking notice outside chat/session state. Release scripts generate and audit a schema-2 manifest from immutable native artifacts before npm `latest` promotion.

**Tech Stack:** TypeScript, Bun test, Next.js route handlers, Electron IPC, React, electron-builder, GitHub Actions, npm registry, Gitee Release.

## Global Constraints

- CLI, resident WebApp, and Desktop use one exact AgentRoam version.
- Stable detection reads only `https://registry.npmjs.org/agentroam/latest`; prereleases and downgrades are rejected.
- Gitee URLs are constructed locally for owner `caoqu`, repository `team-agent`, and tag `v<version>`; remote manifests cannot supply URLs.
- Detection starts 6-30 seconds after usability, runs at most every six hours, coalesces concurrent work, uses a short timeout and ETag, and silently retains the last usable result on failure.
- No installer bytes are downloaded before an explicit user action.
- CLI/WebApp installs preserve the AgentRoam data directory and run through a detached helper so the resident service may restart safely.
- Desktop downloads an unsigned macOS arm64 DMG or Windows x64 NSIS EXE, verifies SHA-256, and reveals the file without executing it.
- Update state must remain separate from session loading, message streaming, history pagination, project switching, and chat rendering state.
- This implementation must not publish npm packages, push tags, create Gitee releases, or modify existing generated `.next`, rollback, `.claude`, `.workbuddy`, or `outputs` files.

---

### Task 1: Shared Update Domain

**Files:**
- Create: `packages/core/src/domain/update/update-release.ts`
- Create: `packages/core/src/domain/update/update-checker.ts`
- Create: `packages/core/src/domain/update/update-release.test.ts`
- Create: `packages/core/src/domain/update/update-checker.test.ts`
- Create: `packages/core/src/domain/update/index.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: injected `fetch(input, init)`, clock, timer, local version, client kind, and platform key.
- Produces: `UpdateStatus`, `UpdateReleaseManifest`, `parseStableVersion()`, `compareStableVersions()`, `validateReleaseManifest()`, `buildGiteeAssetUrl()`, and `UpdateChecker`.

- [x] **Step 1: Define immutable update contracts**

Add discriminated update phases (`idle`, `checking`, `up-to-date`, `available`, `unavailable`, `downloading`, `installing`, `reconnecting`, `complete`, `failed`), platform keys, schema-2 manifest asset types, timestamps, optional progress, and sanitized messages.

- [x] **Step 2: Implement strict release validation**

Accept only stable `major.minor.patch` strings, lowercase 64-character SHA-256 digests, `channel: "latest"`, the exact candidate version, and expected platform file names. Construct asset URLs as:

```ts
export function buildGiteeAssetUrl(version: string, fileName: string): string {
  return `https://gitee.com/caoqu/team-agent/releases/download/v${version}/${encodeURIComponent(fileName)}`;
}
```

- [x] **Step 3: Implement asynchronous detection**

`UpdateChecker.getStatus()` returns memory state synchronously; `refresh({ force })` shares one promise, respects a six-hour successful/attempt cache, sends `If-None-Match`, applies an abort timeout, validates npm then Gitee metadata, and keeps an earlier `available`/`up-to-date` result when a refresh fails. `schedule()` uses injected jitter and an unreferenced timer.

- [x] **Step 4: Add focused domain tests**

Cover stable parsing/comparison, prerelease and downgrade rejection, schema/version/channel/file/hash rejection, URL construction, initial jitter, cache interval, ETag/304, single-flight refresh, timeout, and stale-result retention.

### Task 2: CLI Update Command And Detached Worker

**Files:**
- Create: `packages/cli/src/update/update-state.ts`
- Create: `packages/cli/src/update/update-command.ts`
- Create: `packages/cli/src/update/update-worker.ts`
- Create: `packages/cli/src/update/update-command.test.ts`
- Modify: `packages/cli/src/args.ts`
- Modify: `packages/cli/src/args.test.ts`
- Modify: `packages/cli/src/cli.ts`

**Interfaces:**
- Consumes: validated exact version/asset from the shared domain, existing platform installer contract, `AGENTROAM_HOME`, and service commands.
- Produces: public `agentroam update [version]`, hidden `agentroam update-worker <state-file>`, `readUpdateState()`, and `startDetachedUpdate()`.

- [x] **Step 1: Extend CLI argument parsing**

Parse `update` with an optional exact stable version and the internal worker state-file argument; update help text and reject extra or malformed arguments.

- [x] **Step 2: Add durable state and lock primitives**

Write JSON atomically under `<data-dir>/updates/state.json`, acquire `<data-dir>/updates/update.lock` with exclusive creation, recover a stale lock after a bounded age, and never traverse or delete outside the updates directory.

- [x] **Step 3: Implement user-initiated update startup**

When no version is supplied, force the shared checker; when a version is supplied, require it to match the validated cached candidate. Persist the exact version, expected file name/hash, current launcher path, data directory, and phase before spawning the current executable detached with `update-worker`.

- [x] **Step 4: Implement the detached worker**

Download the versioned shell or PowerShell installer into the updates temp directory, verify SHA-256, invoke it with the exact version and official npm registry, and use existing service/health commands. Preserve old service details until health succeeds and record `complete` or a sanitized `failed` state; delete only its own temporary artifact and lock.

- [x] **Step 5: Add focused CLI tests**

Cover argument parsing, exact candidate enforcement, exclusive lock behavior, state atomicity, checksum mismatch, detached spawn arguments, and sanitized failure serialization with process/filesystem dependencies injected.

### Task 3: Server Update Service And API

**Files:**
- Create: `packages/server/lib/update-service.ts`
- Create: `packages/server/lib/update-service.test.ts`
- Create: `packages/server/app/api/update/status/route.ts`
- Create: `packages/server/app/api/update/check/route.ts`
- Create: `packages/server/app/api/update/install/route.ts`
- Create: `packages/server/app/api/update/update-routes.test.ts`

**Interfaces:**
- Consumes: `UpdateChecker`, durable CLI update state, packaged-runtime environment values, and `startDetachedUpdate()`.
- Produces: singleton `getUpdateService()` with `status()`, `requestCheck()`, and `installAvailable()`; JSON route handlers at `/api/update/*`.

- [x] **Step 1: Build the process-local update service**

Initialize a singleton after module load, schedule delayed detection without awaiting it, merge cached network state with durable installation progress, and expose install only when the current launcher path and managed data directory are configured.

- [x] **Step 2: Add immediate local API routes**

`GET status` returns cached state; `POST check` starts `void requestCheck()` and immediately returns cached state with `202`; `POST install` accepts no URL/version/hash fields and starts the validated cached target once. Apply the repository's existing origin/auth response helpers.

- [x] **Step 3: Add service and route tests**

Assert check does not await network I/O, status performs no remote request, install refuses unsupported runtimes/arbitrary body inputs, concurrent install returns active state, and exposed errors contain no paths, headers, or environment values.

### Task 4: Desktop Main-Process Update Service

**Files:**
- Create: `packages/desktop/main/update-service.ts`
- Create: `packages/desktop/main/update-service.test.ts`
- Modify: `packages/desktop/main/index.ts`
- Modify: `packages/desktop/main/preload.ts`
- Modify: `packages/desktop/renderer/global.d.ts`

**Interfaces:**
- Consumes: shared `UpdateChecker`, Electron `app.getVersion()`, `app.getPath("downloads")`, `shell.showItemInFolder()`, and allowlisted Gitee asset construction.
- Produces: IPC channels `update:get-status`, `update:check`, `update:install`, and pushed `update:status` events exposed as typed `agentApi` methods.

- [x] **Step 1: Implement the Desktop update adapter**

Map `darwin/arm64` and `win32/x64` to manifest platform keys, schedule detection after app readiness, download only the cached validated asset to a collision-safe Downloads filename, stream progress, hash the file, and reveal it after validation. Reject unsupported platforms and remove only the failed partial file.

- [x] **Step 2: Register narrow IPC handlers**

Renderer requests contain no URL, file name, hash, or shell command. Register the service once and publish status changes to the active window without introducing any session/event coupling.

- [x] **Step 3: Expose typed preload methods**

Add `getUpdateStatus()`, `checkForUpdate()`, `installUpdate()`, and `onUpdateStatus(callback)` to preload and `Window.agentApi`, with listener cleanup.

- [x] **Step 4: Add Desktop service tests**

Cover platform allowlisting, delayed checking, no pre-download, progress, collision-safe destination, checksum failure cleanup, successful reveal, unsupported platform, and proof that the installer is never launched.

### Task 5: Web Adapter And Shared Update Notice

**Files:**
- Modify: `packages/webapp/src/infrastructure/http/agent-http-gateway.ts`
- Modify: `packages/webapp/src/infrastructure/http/agent-http-gateway.test.ts`
- Create: `packages/desktop/renderer/components/UpdateNotice.tsx`
- Create: `packages/desktop/renderer/components/UpdateNotice.test.tsx`
- Modify: `packages/desktop/renderer/App.tsx`
- Modify: the renderer stylesheet that owns global overlays/notices.

**Interfaces:**
- Consumes: typed `window.agentApi` update methods backed by HTTP in WebApp and IPC in Desktop.
- Produces: a small dismissible `UpdateNotice` that calls install only after a click and displays download/install/reconnect/retry phases.

- [x] **Step 1: Add WebApp HTTP methods**

Map cached status to `GET /api/update/status`, delayed background check to `POST /api/update/check`, install to `POST /api/update/install`, and provide a no-op unsubscribe because Server status is polled only while an update is active. The check route must return the newly published `checking` state so WebApp begins polling while the request continues in the background.

- [x] **Step 2: Build the isolated notice component**

On mount read cached state, then trigger the background check after the shared 6–30 second startup delay. Render only for actionable states, keep dismissal in `sessionStorage` keyed by target version, use Lucide download/close/refresh icons, and poll only during checking/install/reconnect. Do not read or write chat/session stores.

- [x] **Step 3: Mount and style the notice**

Place the notice as a fixed, responsive application-level element with stable dimensions and no impact on chat layout, composer height, session virtualization, or history scroll anchoring.

- [x] **Step 4: Add renderer and gateway tests**

Cover cached-first display, background check invocation, dismissal by version, click-only install, retry, active progress, WebApp reconnect polling, Desktop event subscription cleanup, and exact HTTP methods.

### Task 6: Unified Desktop Packaging

**Files:**
- Modify: `packages/desktop/package.json`
- Create: `packages/desktop/electron-builder.yml`
- Create: `scripts/audit-desktop-artifacts.mjs`
- Create: `scripts/audit-desktop-artifacts.test.mjs`
- Modify: root `package.json`
- Modify: `bun.lock`

**Interfaces:**
- Consumes: built Electron main/preload/renderer output and the repository version.
- Produces: unsigned `AgentRoam-<version>-arm64.dmg` and `AgentRoam-Setup-<version>-x64.exe` plus an allowlist audit command.

- [x] **Step 1: Configure native Electron packaging**

Add electron-builder as a development dependency with scripts for macOS arm64 DMG and Windows x64 NSIS. Set `identity: null`, disable signing discovery, define deterministic artifact names, and include only compiled outputs, package metadata, icons/licenses, and required declared resources.

- [x] **Step 2: Add packaged-content auditing**

Inspect the unpacked app/archive file list and fail on `.agent-data`, sessions, SQLite databases, `.env`, `.npmrc`, repository Git metadata, caches, rollback output, or files outside the declared allowlist.

- [x] **Step 3: Synchronize the Desktop version**

Set `packages/desktop/package.json` to the root AgentRoam version and add it to version-update/drift policy tests.

- [x] **Step 4: Add packaging contract tests**

Verify artifact names, unsigned settings, architecture targets, include allowlist, denylist audit, and version consistency without requiring a cross-platform build.

### Task 7: Schema-2 Release Pipeline And Gitee Assets

**Files:**
- Modify: `scripts/agentroam-release-lib.mjs`
- Modify: `scripts/publish-agentroam-release.mjs`
- Modify: `scripts/publish-agentroam-release.test.mjs`
- Modify: `scripts/collect-cli-artifacts.mjs` or create a release-artifact aggregation script.
- Modify: `scripts/agent-runtime-upgrade-lib.mjs`
- Modify: `scripts/agent-runtime-upgrade.test.mjs`
- Modify: `scripts/agent-runtime-diff-policy.mjs`
- Modify: `.github/workflows/agent-runtime-publish.yml`
- Modify: `.github/workflows/agent-runtime-soak.yml`
- Modify: `packages/cli/RELEASE.md`

**Interfaces:**
- Consumes: six platform npm tarballs, launcher tarball, shell/PowerShell installers, native Desktop artifacts, and release version.
- Produces: schema-2 `release-manifest.json`, `SHA256SUMS`, verified Gitee Release assets, and a gate that must pass before moving npm tags to `latest`.

- [x] **Step 1: Extend manifest generation and validation**

Generate `channel`, `publishedAt`, platform-keyed CLI/Desktop installer metadata, exact sizes and SHA-256 values. Validate deterministic filenames and fail when a required Desktop or CLI asset is absent.

- [x] **Step 2: Aggregate native build artifacts**

Upload macOS and Windows Desktop artifacts from native jobs, download them into the release job alongside CLI artifacts, run the Desktop content audit, and then generate one manifest/checksum set.

- [x] **Step 3: Extend Gitee synchronization**

Create/update only the exact `v<version>` release, upload `release-manifest.json`, CLI installers, Desktop installers, and checksums, then download each uploaded asset and compare size/hash before returning success.

- [x] **Step 4: Preserve final latest-tag ordering**

Keep platform npm packages before the launcher, finish preview soak and Gitee verification first, and make the six platform plus launcher `latest` tag move the final availability switch.

- [x] **Step 5: Update version drift and operator documentation**

Teach the version updater/diff policy about Desktop metadata and schema 2. Document native runner requirements, unsigned package expectations, exact artifact names, Gitee variables, retry/rollback behavior, and the rule that no remote publication occurs during local verification.

- [x] **Step 6: Add release contract tests**

Cover missing native asset gates, deterministic file naming, hash mismatch, schema-2 validation, Desktop version drift, upload allowlist, verification-before-latest ordering, and preview behavior.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run:

```bash
PATH=/opt/homebrew/opt/node@22/bin:$PATH bunx vitest run \
  packages/core/src/domain/update \
  packages/cli/src/args.test.ts \
  packages/cli/src/update \
  packages/server/lib/update-service.test.ts \
  packages/server/app/api/update/update-routes.test.ts \
  packages/desktop/main/update-service.test.ts \
  packages/desktop/renderer/components/UpdateNotice.test.tsx \
  packages/webapp/src/infrastructure/http/agent-http-gateway.test.ts

PATH=/opt/homebrew/opt/node@22/bin:$PATH node --test \
  scripts/audit-desktop-artifacts.test.mjs \
  scripts/publish-agentroam-release.test.mjs \
  scripts/agent-runtime-upgrade.test.mjs
```

Expected: all focused tests pass.

Then run:

```bash
PATH=/opt/homebrew/opt/node@22/bin:$PATH bun run typecheck
```

Expected: all workspace TypeScript checks pass. If a test or typecheck fails, fix the implementation or test and rerun until it passes; if a pre-existing unrelated failure remains, isolate and report it with evidence.
