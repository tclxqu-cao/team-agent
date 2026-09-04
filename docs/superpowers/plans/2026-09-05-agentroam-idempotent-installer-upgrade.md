# AgentRoam Idempotent Installer Upgrade Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make repeated AgentRoam installer runs replace the existing macOS or Windows user service only after the old process has stopped, preserve application data, and publish the verified fix as `0.2.0-preview.11`.

**Architecture:** Keep upgrade orchestration inside the platform `ServiceController` implementations so both versioned installers continue to call a single `service install` command. Each controller validates the new definition first, inspects the old registration, stops and waits for it, removes the old registration, then installs and starts the new definition without deleting the data or log directories.

**Tech Stack:** TypeScript, Node.js 22, Vitest, macOS launchd, Windows Task Scheduler/PowerShell, npm workspaces, Gitee Git and Releases.

## Global Constraints

- Preserve sessions, application configuration, pairing state, logs, managed Node/Codex runtimes, and versioned launchers under the selected data directory.
- Do not force-kill service processes, invoke `sudo`, request administrator privileges, or delete the data directory.
- Keep the external `service install|start|stop|restart|status|url|logs|uninstall` interface unchanged.
- Publish all seven packages as exact version `0.2.0-preview.11`; publish six platform packages before the `agentroam` launcher.
- Use `https://registry.npmjs.org`, `--access public --tag preview --provenance=false`, and a mode-600 temporary npm user config populated from macOS Keychain service `com.agentroam.npm-token`.
- Do not stage or commit existing `.next*`, rollback directories, `.claude/worktrees`, `.workbuddy`, or unrelated user changes.

---

### Task 1: Synchronize macOS LaunchAgent replacement

**Files:**
- Modify: `packages/cli/src/service/macos-launch-agent.ts`
- Unit tests: `packages/cli/src/service/macos-launch-agent.test.ts`

**Interfaces:**
- Consumes: `readServiceState(paths): Promise<ServiceRuntimeState | null>`, `inspectJob(): Promise<{ loaded: boolean; running: boolean }>` and injected `processExists(pid)`.
- Produces: private `waitForServiceExit(pid?: number): Promise<void>` used by `install()` after a successful `launchctl bootout`.

- [x] **Step 1: Add failing reinstall tests**

Add a test runner that keeps `launchctl print` loaded and `processExists(oldPid)` true for at least one poll after `bootout`. Assert `bootstrap` is not called until both become false, and a marker under `data/` plus existing logs remain unchanged.

```ts
expect(calls.indexOf("process-exited")).toBeLessThan(calls.indexOf("launchctl bootstrap"));
expect(await readFile(resolve(paths.dataDir, "data/keep.txt"), "utf8")).toBe("keep");
```

Add a second test with no state PID where `launchctl print` remains loaded briefly after `bootout`, and a timeout test that expects `did not unload after launchctl bootout` without calling `bootstrap`.

- [x] **Step 2: Capture old state before replacing control files**

In `install()`, read the existing runtime state before removing `state.json` and `url`. Validate and lint the temporary plist before stopping the old service.

```ts
const previousState = await readServiceState(paths);
const existingJob = await this.inspectJob();
if (existingJob.loaded) {
  await this.runRequired("launchctl", ["bootout", this.serviceTarget]);
  await this.waitForServiceExit(previousState?.pid);
}
```

- [x] **Step 3: Implement bounded unload waiting**

Poll both the old PID and `launchctl print` against one `stopTimeoutMs` deadline. Return only when the PID is absent and the job is unloaded; throw a PID-specific or label-specific error at the deadline. Reuse `pollIntervalMs` and do not send signals beyond the platform `bootout` command.

### Task 2: Replace existing Windows scheduled tasks safely

**Files:**
- Modify: `packages/cli/src/service/windows-task-service.ts`
- Unit tests: `packages/cli/src/service/windows-task-service.test.ts`

**Interfaces:**
- Consumes: `inspectTask()`, `readServiceState(paths)`, `buildStopTaskScript()`, `buildUnregisterTaskScript()` and `waitForProcessExit(pid)`.
- Produces: an idempotent `install(config)` sequence of optional stop, optional wait, optional unregister, config write, register, and start.

- [x] **Step 1: Add failing repeated-install tests**

Run `install()` twice with the fake Task Scheduler. On the second run, assert the exact lifecycle ordering and that the data marker and log file survive.

```ts
expect(lifecycle).toEqual([
  "stop", "process-exit", "unregister", "register", "start",
]);
```

Add coverage for replacing an installed but stopped task without `Stop-ScheduledTask`, and for a stop timeout that prevents unregister/register.

- [x] **Step 2: Implement stop-and-unregister before config replacement**

Read task status and old runtime state before writing the new config. Stop a running task, wait for its recorded PID, unregister every installed old task, then write new control state and register/start the new task.

```ts
const previousTask = await this.inspectTask();
const previousState = await readServiceState(paths);
if (previousTask.running) await this.runRequired(buildStopTaskScript());
if (previousTask.running && previousState?.pid) await this.waitForProcessExit(previousState.pid);
if (previousTask.installed) await this.runRequired(buildUnregisterTaskScript());
```

### Task 3: Bump and document `0.2.0-preview.11`

**Files:**
- Modify: `packages/cli/package.json`, `packages/runtime-darwin-arm64/package.json`, `packages/runtime-win32-x64/package.json`, `packages/cloudflared-darwin-arm64/package.json`, `packages/cloudflared-win32-x64/package.json`, `packages/tui-darwin-arm64/package.json`, `packages/tui-win32-x64/package.json`
- Modify: `packages/runtime-darwin-arm64/manifest.json`, `packages/runtime-win32-x64/manifest.json`, `packages/cloudflared-darwin-arm64/manifest.json`, `packages/cloudflared-win32-x64/manifest.json`
- Modify: `packages/cli/src/platform-packages.ts`, `packages/cli/src/tunnel/public-readiness.ts`, `packages/cli/src/cloudflared/bundled-asset.test.ts`, `packages/cli/bin/node-preflight.mjs`
- Modify: `packages/cli/install/install-agentroam.sh`, `packages/cli/install/install-agentroam.ps1`, `scripts/verify-cli-install.mjs`, `bun.lock`
- Modify: `packages/cli/README.md`, `packages/cli/install/README.md`, `packages/cli/RELEASE.md`

**Interfaces:**
- Consumes: existing exact-version package graph and `pack:cli:all` workflow.
- Produces: seven mutually consistent `0.2.0-preview.11` packages, versioned installers, verification expectations, and release commands.

- [x] **Step 1: Update machine-readable versions**

Replace release-version occurrences in the listed package manifests, runtime manifests, package mapping, readiness user agent, installer constants, preflight constant, verifier expectation, and lockfile. Keep historical references in design documents unchanged.

- [x] **Step 2: Update release documentation and installer URLs**

Change current installation examples and tarball names to `preview.11`. Add the repeated-install guarantee: the installer stops and replaces the existing current-user service while preserving data and logs.

- [x] **Step 3: Verify version consistency**

Run a scoped search and assert no current release file still references `preview.10` except historical design/background text.

```bash
rg -n '0\.2\.0-preview\.10' packages scripts bun.lock --glob '!**/dist/**'
```

Expected: no output.

### Task 4: Build, verify, and publish

**Files:**
- Generated, not committed: `dist/cli-release/**`
- Commit: only files listed in Tasks 1-3 plus this plan and the approved design
- Release assets: `dist/cli-release/install-agentroam.sh`, `dist/cli-release/install-agentroam.ps1`, `dist/cli-release/SHA256SUMS`

**Interfaces:**
- Consumes: Node.js `22.22.0`, package scripts in root `package.json`, Keychain npm token, Gitee remote `origin`.
- Produces: npm `preview` packages, Git commit, `v0.2.0-preview.11` tag, and Gitee Release assets.

- [x] **Step 1: Run focused development verification**

Run the service controller tests, installer contract tests, CLI tests, and TypeScript build under Node 22. Fix failures before packaging.

```bash
npm exec vitest run -- packages/cli/src/service/macos-launch-agent.test.ts packages/cli/src/service/windows-task-service.test.ts packages/cli/src/service/service-command.test.ts packages/cli/src/install-script-contract.test.ts
npm run --workspace agentroam build
```

- [x] **Step 2: Build and audit release artifacts**

```bash
PATH=/Users/caoqu/.nvm/versions/node/v22.22.0/bin:$PATH npm run pack:cli:all
node scripts/verify-cli-install.mjs --artifacts dist/cli-release --bootstrap-script
```

Verify seven tarballs plus both installers and `SHA256SUMS`, and compare every checksum entry to its file.

- [x] **Step 3: Commit and push source**

Stage only the planned source, test, version and documentation files. Run `git diff --cached --check`, commit the fix, and push `master` using standard Git per project `CLAUDE.md`.

- [x] **Step 4: Publish npm packages**

Create a mode-600 temporary user config from Keychain without echoing the token. Run `npm whoami`, publish six platform tarballs then the launcher, and remove the temporary config on exit.

- [x] **Step 5: Verify npm publication**

Poll the official registry until all seven exact versions resolve and each `preview` dist-tag equals `0.2.0-preview.11`. Download each registry tarball into a new temporary directory and compare SHA-256 with `dist/cli-release`.

- [x] **Step 6: Publish Git tag and Gitee Release**

Create and push annotated tag `v0.2.0-preview.11` at the verified release commit. Create the Gitee Release for that tag and upload both installers plus `SHA256SUMS`; verify public download checksums.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run: `PATH=/Users/caoqu/.nvm/versions/node/v22.22.0/bin:$PATH npm exec vitest run -- packages/cli/src/service/macos-launch-agent.test.ts packages/cli/src/service/windows-task-service.test.ts packages/cli/src/service/service-command.test.ts packages/cli/src/install-script-contract.test.ts`

Expected: PASS

If a test fails, fix the implementation or test and rerun this command until it passes. Report the command and result in the final response.
