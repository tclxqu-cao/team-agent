# AgentRoam macOS LaunchAgent Service Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicit macOS LaunchAgent lifecycle to the globally installed AgentRoam npm CLI so its Web runtime and tunnel survive terminal closure and user login restarts.

**Architecture:** One `com.agentroam.service` LaunchAgent runs the existing AgentRoam CLI parent, which continues supervising the Web gateway and tunnel children. Focused service modules own durable config/runtime state and launchctl integration; normal foreground startup remains unchanged.

**Tech Stack:** Node.js 22 ESM, TypeScript, macOS launchd/launchctl/plutil, Vitest, npm workspaces.

## Global Constraints

- The service integration is macOS-only and uses a user LaunchAgent, never a privileged LaunchDaemon.
- One plist supervises the existing CLI parent; do not split the Web runtime and tunnel into separate jobs.
- npm `postinstall` must not install or start services.
- The plist must use absolute Node and CLI paths and must not depend on shell expansion or launchd PATH lookup.
- The default root is the directory where `service install` is invoked; do not expose the entire home directory implicitly.
- Service config, runtime state, URL, and logs must not be writable by other users.
- Existing non-service CLI commands and macOS/Windows foreground startup behavior must remain compatible.
- Publish version `0.2.0-preview.9` because `0.2.0-preview.8` already exists on the official npm registry.

---

### Task 1: Service Command Model

**Files:**
- Modify: `packages/cli/src/args.ts`
- Modify: `packages/cli/src/args.test.ts`

**Interfaces:**
- Produces: `ServiceAction = "install" | "status" | "url" | "logs" | "restart" | "uninstall"`.
- Produces: `CliOptions.serviceAction: ServiceAction | null` while preserving existing start options.

- [ ] **Step 1: Extend command parsing with a service action**

Parse `service` followed by exactly one supported action. Permit start options only for `service install`; reject missing actions and unsupported trailing options for read-only actions.

```ts
export type CliCommand = "start" | "doctor" | "version" | "service";
export type ServiceAction = "install" | "status" | "url" | "logs" | "restart" | "uninstall";
```

- [ ] **Step 2: Preserve install-time root behavior**

Use `process.cwd()` when `service install` has no `--root`, exactly as foreground start does. Keep repeatable roots and existing relay validation.

- [ ] **Step 3: Add focused parser tests**

Cover every service action, missing/unknown actions, install options, and rejection of options on `status`, `url`, `logs`, `restart`, and `uninstall`.

### Task 2: Durable Service Files

**Files:**
- Create: `packages/cli/src/service/service-files.ts`
- Create: `packages/cli/src/service/service-files.test.ts`

**Interfaces:**
- Produces: `resolveServicePaths(homeDir?: string, dataDir?: string): ServicePaths`.
- Produces: `writePrivateJson(path, value)`, `writePrivateText(path, value)`, and `removeIfExists(path)`.
- Produces: `readServiceConfig(paths): Promise<ServiceConfig | null>` and runtime-state helpers guarded by PID.

- [ ] **Step 1: Define stable paths and serialized types**

```ts
export interface ServiceConfig {
  version: string;
  nodePath: string;
  cliPath: string;
  roots: string[];
  port: number | null;
  relay: RelayMode;
  tunnelCommand: string | null;
  localOnly: boolean;
  dataDir: string;
  installedAt: string;
}
```

Put the plist under `~/Library/LaunchAgents`, control metadata under `~/.agentroam/service`, and runtime URL/log files under the configured data directory.

- [ ] **Step 2: Implement atomic private writes**

Create parent directories with `0700`, write a same-directory temporary file with `0600`, fsync/close it, rename it over the destination, and chmod the final file to `0600`.

- [ ] **Step 3: Implement PID-guarded runtime cleanup**

Only a process whose PID matches the current saved state may mark it stopped and remove `tunnel.url`.

- [ ] **Step 4: Test paths, permissions, replacement, and PID guards**

Use temporary home/data directories. Assert exact locations, mode bits, new content after replacement, stale URL removal on startup, and rejection of cleanup from an older PID.

### Task 3: macOS LaunchAgent Controller

**Files:**
- Create: `packages/cli/src/service/macos-launch-agent.ts`
- Create: `packages/cli/src/service/macos-launch-agent.test.ts`

**Interfaces:**
- Consumes: `ServiceConfig`, `ServicePaths`, and private file helpers from Task 2.
- Produces: `MacLaunchAgent` with `install`, `status`, `url`, `logs`, `restart`, and `uninstall` methods.
- Produces: an injected `CommandRunner` based on `execFile` for deterministic tests.

- [ ] **Step 1: Serialize the foreground start arguments**

Create deterministic `ProgramArguments` beginning with `config.nodePath`, `config.cliPath`, and `start`; append every root and configured relay/data option as separate arguments. Never construct a shell command string.

- [ ] **Step 2: Generate and validate the plist through plutil**

Write a temporary JSON property list containing the label, arguments, working directory, log paths, `AGENTROAM_SERVICE=1`, `RunAtLoad=true`, `KeepAlive=true`, and `ThrottleInterval=5`. Convert it with `plutil -convert xml1`, lint it, then atomically replace the target plist with mode `0600`.

- [ ] **Step 3: Implement launchctl lifecycle methods**

Address the service as `gui/${process.getuid()}/com.agentroam.service`. Use `bootout`, `bootstrap`, `kickstart -k`, and `print` with argument arrays. Treat only the documented absent-job result as idempotent during bootout.

- [ ] **Step 4: Implement status, URL, logs, and uninstall behavior**

Status reports installed/running separately and includes saved PID/version/root/URL when available. URL rejects missing, non-ready, or stale state. Logs print both paths and bounded recent content. Uninstall preserves application data and logs while removing service control/state/URL files.

- [ ] **Step 5: Add controller tests**

Assert exact launchctl/plutil calls, plist fields, start argument quoting boundaries, install reload order, ready polling, idempotent uninstall, absent service status, stale URL rejection, and non-destructive data preservation.

### Task 4: Runtime State Integration

**Files:**
- Modify: `packages/cli/src/cli.ts`
- Create: `packages/cli/src/service/runtime-state.ts`
- Create: `packages/cli/src/service/runtime-state.test.ts`

**Interfaces:**
- Consumes: `AGENTROAM_SERVICE=1` and service file helpers.
- Produces: `runServiceCommand(options, context)` and `ServiceRuntimeReporter`.

- [ ] **Step 1: Dispatch service commands before platform runtime startup**

Reject service commands unless `process.platform === "darwin"`. Resolve the CLI entry as an absolute installed path and reject paths containing an npm `_npx` cache segment during install.

- [ ] **Step 2: Add background runtime reporting**

When `AGENTROAM_SERVICE=1`, write `starting` before creating children, `ready` after relay selection, and PID-guarded `stopped` during final cleanup. Write the full access URL to `tunnel.url` with mode `0600`.

- [ ] **Step 3: Keep secrets out of launchd logs**

In service mode, do not print the access URL, QR code, or pairing token. Foreground mode retains the current terminal output exactly.

- [ ] **Step 4: Test service-mode lifecycle reporting**

Inject temporary paths and fixed timestamps/PIDs. Verify starting/ready/stopped transitions, URL publication, redaction behavior, and that ordinary foreground state creates no service files.

### Task 5: Documentation And Package Verification

**Files:**
- Modify: `packages/cli/README.md`
- Modify: `packages/cli/RELEASE.md`
- Modify: `scripts/audit-cli-tarball.mjs`
- Modify: `scripts/verify-cli-install.mjs`

**Interfaces:**
- Consumes: packaged `agentroam` executable.
- Produces: release verification evidence that service modules and commands exist in the installed launcher package.

- [ ] **Step 1: Document the explicit service lifecycle**

Document global install, install/status/url/logs/restart/uninstall commands, login-time semantics, one-plist/three-process behavior, Quick Tunnel hostname limits, and the need to rerun install after changing Node/npm installation paths.

- [ ] **Step 2: Extend tarball audit coverage**

Require the compiled service controller and runtime-state modules in the CLI tarball without widening the existing top-level allowlist.

- [ ] **Step 3: Extend clean-install verification**

After installing the tarballs, run a non-mutating service parser/status check on macOS and assert the command is available. Do not install the user's real LaunchAgent from the generic smoke script.

### Task 6: Version Alignment And Release Artifacts

**Files:**
- Modify: `packages/cli/package.json`
- Modify: platform `package.json` and manifest files under `packages/runtime-*`, `packages/cloudflared-*`, and `packages/tui-*`
- Modify: version-bearing release workflow/document files found by an exact `0.2.0-preview.8` search
- Modify: `bun.lock`

**Interfaces:**
- Produces: seven aligned `0.2.0-preview.9` npm packages and matching artifact names/checksums.

- [ ] **Step 1: Enumerate every version-bearing file**

Run `rg -n "0\\.2\\.0-preview\\.8"` and classify launcher dependency versions, platform manifests, workflows, docs, and historical evidence. Change only current release contracts; preserve historical design statements where the old version is evidence.

- [ ] **Step 2: Align active release metadata to preview.9**

Set all seven package versions to `0.2.0-preview.9`, update the launcher's six exact optional dependencies, and update matching manifests and active release instructions.

- [ ] **Step 3: Build and collect release artifacts**

Use Node 22 to run `npm run pack:cli:all`. Confirm `dist/cli-release` contains exactly seven preview.9 tarballs plus `SHA256SUMS` and no stale preview.8 artifact.

### Task 7: Real macOS Service And npm Release Verification

**Files:**
- Modify only implementation defects revealed by verification.

**Interfaces:**
- Consumes: preview.9 release artifacts.
- Produces: clean-install, live LaunchAgent, tunnel, and official npm registry evidence.

- [ ] **Step 1: Run clean install and tunnel smoke tests**

Run `node scripts/verify-cli-install.mjs --artifacts dist/cli-release` and `node scripts/verify-cli-tunnel.mjs --artifacts dist/cli-release --provider auto` under Node 22. Require doctor, native modules, PTY, local server, Web App, and public relay checks to pass.

- [ ] **Step 2: Verify a real LaunchAgent lifecycle**

Install preview.9 tarballs into a durable temporary npm prefix, invoke `agentroam service install --root <temporary-root> --port <free-port>`, verify launchctl reports running and `service url` matches the private URL file, close the invoking shell, verify stable service and child PIDs, restart, and uninstall. Confirm application data remains.

- [ ] **Step 3: Publish in dependency order**

Publish six platform tarballs and then the launcher with `--access public --tag preview --registry https://registry.npmjs.org`. If npm requests WebAuthn, surface the authentication window while keeping already published package evidence intact.

- [ ] **Step 4: Verify official registry state**

Wait until all seven packages expose `preview=0.2.0-preview.9`, install with an isolated npm cache from the official registry, and run `agentroam version`, `agentroam doctor`, and non-mutating service status.

### Task 8: Restart Production Port 3000

**Files:**
- Modify only deployment artifacts required by the existing project release procedure.

**Interfaces:**
- Produces: the current customer-agent Web build running under its existing launchd job on port 3000.

- [ ] **Step 1: Follow the customer-agent Web release skill**

Restore the existing launchd ownership model, build with Node 22 and the correct `better-sqlite3` ABI, restart `com.agentroam.customer-agent.webapp`, and retain a recoverable previous build as required by the release procedure.

- [ ] **Step 2: Verify production health and stability**

Require HTTP 200 from `/web`, `/api/agent/runtime-health`, and `/api/sessions`; sample the launchd PID repeatedly and require it to remain stable.

## Final Unit Test Verification

- [ ] **Main agent: run affected unit tests after development is complete**

Run:

```bash
bunx vitest run packages/cli/src
bunx tsc -p packages/cli/tsconfig.json --noEmit
git diff --check
```

Expected: every CLI test passes, TypeScript reports no errors, and the diff has no whitespace errors.

If a test fails, fix the implementation or test and rerun these commands until they pass. Report the commands and results in the final response.
