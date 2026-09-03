# Managed Codex Runtime Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AgentRoam discover and safely follow native Codex Desktop sessions on macOS arm64 and Windows x64 even when the user has no global Codex CLI.

**Architecture:** The launcher resolves one exact-version Codex executable before starting the bundled Server and injects it through `AGENT_CODEX_BIN`. The existing app-server protocol remains the only session reader; platform-specific occupancy and path normalization are added at the adapter/service boundaries without changing macOS `lsof` semantics.

**Tech Stack:** Node.js 22, TypeScript, npm package installation, Electron runtime adapters, Vitest.

## Global Constraints

- Lock the official Codex package to exactly `@openai/codex@0.153.0`; never query or follow `latest` during startup.
- Resolution order is `AGENT_CODEX_BIN`, compatible PATH CLI, compatible managed runtime, then exact-version managed install.
- Managed runtimes live at `<dataDir>/runtimes/codex/<version>` and global Codex installations are never modified.
- Support managed installation on macOS arm64 and Windows x64; native WSL discovery is out of scope.
- Honor non-empty `CODEX_HOME`; otherwise use `<homedir>/.codex`.
- Preserve the existing non-Windows `lsof` command, PID filtering, and idle timeout behavior.
- On Windows, use rollout lifecycle state for external occupancy and retain app-server `SESSION_OCCUPIED` as final writer arbitration.
- Compare Windows project paths case-insensitively with path-boundary and longest-root semantics; keep POSIX comparison case-sensitive.
- Codex setup failure must not prevent the rest of AgentRoam from starting.

---

### Task 1: Exact-Version Managed Codex Runtime

**Files:**
- Create: `packages/cli/src/codex-runtime-manager.ts`
- Create: `packages/cli/src/codex-runtime-manager.test.ts`

**Interfaces:**
- Consumes: `PlatformTarget`, launcher `dataDir`, environment/PATH, Node/npm executables.
- Produces: `CODEX_RUNTIME_VERSION`, `CodexRuntimeResolution`, `resolveCodexRuntime(options): Promise<CodexRuntimeResolution>`, and `resolveNpmExecutor(options): Promise<{ command: string; argsPrefix: string[] }>`.

- [x] **Step 1: Define resolution and validation contracts**

Implement injectable filesystem/process dependencies so tests can validate lookup and install behavior without downloading packages. Return `{ executable, version, source }` where source is `explicit`, `global`, or `managed`; throw typed errors whose messages distinguish incompatible versions, missing npm, install failure, and validation failure.

- [x] **Step 2: Implement exact version validation and PATH lookup**

Parse `codex --version` output with a strict numeric version token and accept only `0.153.0`. Resolve PATH candidates as `codex` on POSIX and `codex.exe`/`codex.cmd` on Windows, requiring file access before validation.

- [x] **Step 3: Implement locked installation and native binary resolution**

Run npm with argument arrays equivalent to:

```text
npm install --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org --prefix <temp> @openai/codex@0.153.0
```

Resolve the installed native binary from `node_modules/@openai/codex-<platform>/vendor/<target>/codex[.exe]`, validate the path remains below the temporary install root, repair POSIX executable permissions, validate the version, then atomically rename the sibling temporary directory to `<dataDir>/runtimes/codex/0.153.0`.

- [x] **Step 4: Add concurrent-install locking and stale recovery**

Acquire `<dataDir>/runtimes/codex/0.153.0.lock` using exclusive creation. Poll a live lock for a bounded interval, remove only locks older than the configured stale threshold, and revalidate the final runtime after another process completes. Always remove a lock owned by this process and remove only the current process's validated temporary directory.

- [x] **Step 5: Add focused runtime-manager tests**

Cover explicit/global/managed/install ordering, exact version rejection, `npm_execpath` selection through `process.execPath`, Windows `npm.cmd` fallback, platform binary paths, cached startup without installation, successful atomic install, failed-install cleanup, and two concurrent callers performing one install.

### Task 2: Launcher Integration and Diagnostics

**Files:**
- Modify: `packages/cli/src/runtime-manager.ts`
- Modify: `packages/cli/src/cli.ts`
- Create: `packages/cli/src/runtime-manager.test.ts`

**Interfaces:**
- Consumes: `resolveCodexRuntime({ dataDir, target })` from Task 1.
- Produces: Server child environment containing an absolute `AGENT_CODEX_BIN` when resolution succeeds; `doctor` reports the selected source/version/path.

- [x] **Step 1: Resolve Codex before spawning Server**

Call the manager after creating the data directories. Log progress through an injected/default reporter. On success add `AGENT_CODEX_BIN: resolution.executable`; on failure warn with an actionable message, remove any inherited unusable `AGENT_CODEX_BIN`, and continue spawning the Server.

- [x] **Step 2: Keep the child environment and runtime lifecycle stable**

Preserve all current environment keys, bundled runtime permission repair, health wait, stream forwarding, and shutdown behavior. Add constructor injection for the resolver only where needed for deterministic tests.

- [x] **Step 3: Extend `doctor`**

Resolve the same managed runtime and print its exact version, source, and executable. Report resolution failure with the existing doctor failure mechanism while continuing the remaining checks.

- [x] **Step 4: Test success and degraded startup**

Assert resolved binaries are injected unchanged and resolution errors still spawn the Server without `AGENT_CODEX_BIN` while emitting one warning.

### Task 3: Codex Home and Windows Occupancy

**Files:**
- Modify: `packages/desktop/main/agent-runtime/codex-runtime-adapter.ts`
- Modify: `packages/desktop/main/agent-runtime/codex-runtime-adapter.test.ts`
- Modify: `packages/desktop/main/agent-runtime/native-processes.ts`
- Modify: `packages/desktop/main/agent-runtime/native-processes.test.ts`
- Modify: `packages/desktop/main/agent-runtime/native-runtime-broker.ts`

**Interfaces:**
- Produces: `resolveCodexHome(environment, homeDir): string`; `listOpenSessionFiles(..., options, platform): Promise<Set<string>>`; adapter options `platform?: NodeJS.Platform`, `codexExecutable?: string`, and consistent health/app-server executable use.

- [x] **Step 1: Centralize Codex home resolution**

Use trimmed `CODEX_HOME` when present and otherwise `join(homedir(), ".codex")`. Derive both the default session root and user-level skill path from that home; retain explicit `sessionRoot` test overrides.

- [x] **Step 2: Make process occupancy platform-aware**

Return an empty set immediately on `win32` without invoking `lsof`. Keep the exact existing `lsof +c 0 -a -c <command> -FpFn` execution path for all other platforms. Inject the executor in tests to assert both branches.

- [x] **Step 3: Project Windows rollout lifecycle into occupancy**

For Windows discovery/detail, read activity for every absolute thread rollout path. Treat `running` as `owned-externally`, `status: running`, and `canResume: false`; treat idle/unknown as available. On non-Windows, continue requiring an externally open rollout and use lifecycle only to refine running versus idle status.

- [x] **Step 4: Align health with the selected executable**

Store the executable passed to the adapter, use it for `--version`, and have broker host construction pass the same absolute executable to both `CodexAppServerClient` and `CodexRuntimeAdapter`.

- [x] **Step 5: Add focused platform tests**

Cover `CODEX_HOME`, default home, Windows skipping `lsof`, macOS preserving `lsof` arguments/output parsing, Windows running rollout occupancy, Windows idle rollout resumability, and unchanged macOS held-open behavior.

### Task 4: Cross-Drive Windows Project Association

**Files:**
- Modify: `packages/server/lib/native-runtime-service.ts`
- Modify: `packages/server/lib/native-runtime-service.test.ts`

**Interfaces:**
- Produces: exported/testable `normalizeProjectPath(path, platform)` and platform-aware `associateLocalProject(session, projects, platform)` behavior.

- [x] **Step 1: Add platform-specific path normalization**

Use `path.win32.resolve()` plus lowercase comparison keys on Windows and current `path.resolve()` comparison keys elsewhere. Preserve root paths while removing non-root trailing separators.

- [x] **Step 2: Apply boundary-safe longest-root matching**

Match when comparison keys are equal or cwd begins with `root + platformSeparator`, then sort by normalized root length descending. Thread `process.platform` through service construction as an optional test dependency.

- [x] **Step 3: Add Windows and POSIX tests**

Cover drive-letter/directory case changes, a `D:\\repo` project matching `d:\\REPO\\packages\\app`, `D:\\repo-old` not matching `D:\\repo`, nested longest-root selection, and POSIX case sensitivity.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run:

```bash
bunx vitest run packages/cli/src/codex-runtime-manager.test.ts packages/cli/src/runtime-manager.test.ts packages/desktop/main/agent-runtime/native-processes.test.ts packages/desktop/main/agent-runtime/codex-runtime-adapter.test.ts packages/server/lib/native-runtime-service.test.ts
bunx tsc --noEmit -p packages/cli/tsconfig.json
bunx tsc --noEmit -p packages/desktop/tsconfig.json
bunx tsc --noEmit -p packages/server/tsconfig.json
git diff --check
```

Expected: all focused tests and TypeScript checks pass, and `git diff --check` reports no whitespace errors. Then run a macOS arm64 managed-runtime smoke check in a temporary AgentRoam data directory and report Windows real-machine validation as outstanding when no Windows host is available.
