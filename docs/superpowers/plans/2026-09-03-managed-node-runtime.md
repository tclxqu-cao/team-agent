# Managed Node.js 22 Runtime Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let AgentRoam install and use a private Node.js 22 runtime on macOS arm64 and Windows x64 when Node is absent or the current Node major is not 22.

**Architecture:** A small launcher preflight runs before the regular CLI import and re-executes through an exact, verified private Node runtime when necessary. Standalone Shell and PowerShell installers bootstrap machines with no Node, while release collection publishes those scripts as versioned assets.

**Tech Stack:** Node.js ESM, TypeScript, POSIX Shell, PowerShell 5+, official Node.js archives, SHA-256, Vitest, GitHub Actions Windows/macOS runners.

## Global Constraints

- Reuse any system Node 22 without modifying or upgrading it.
- Install private Node exactly `22.22.0`; future updates happen only through an AgentRoam release.
- Store private Node at `<dataDir>/runtimes/node/22.22.0` and retain prior verified versions.
- Download only `node-v22.22.0-darwin-arm64.tar.xz` or `node-v22.22.0-win-x64.zip` from `https://nodejs.org/dist/v22.22.0/`.
- Require SHA-256 `2bd596bbfc4a275ceb8721a5954ee97daea5ebe673e96a185ebd732f6fb023ac` on macOS and `c97fa376d2becdc8863fcd3ca2dd9a83a9f3468ee7ccf7a6d076ec66a645c77a` on Windows.
- Do not use Homebrew, winget, Chocolatey, nvm, fnm, Volta, administrator rights, or machine-level PATH changes.
- Complete Node switching before Server, `better-sqlite3`, or `node-pty` loads.
- Managed bootstrap supports macOS arm64 and Windows x64 only; Linux, WSL, macOS Intel, and Windows arm64 remain unsupported.
- Existing unrelated worktree changes must remain untouched.

---

### Task 1: Managed Node Manifest and Installer

**Files:**
- Create: `packages/cli/src/node-runtime-manager.ts`
- Create: `packages/cli/src/node-runtime-manager.test.ts`

**Interfaces:**
- Produces: `MANAGED_NODE_VERSION`, `NodeRuntimeTarget`, `NodeRuntimeAsset`, `detectNodeRuntimeTarget(platform, arch)`, `managedNodeExecutable(dataDir, target)`, and `ensureManagedNode(options): Promise<NodeRuntimeResolution>`.
- Consumes: `dataDir`, platform/arch, injected downloader/process runner, filesystem, and the exact manifest constants.

- [x] **Step 1: Define the exact runtime manifest**

Create immutable platform entries:

```ts
export const MANAGED_NODE_VERSION = "22.22.0";
export const NODE_RUNTIME_ASSETS = {
  "darwin-arm64": {
    archive: "node-v22.22.0-darwin-arm64.tar.xz",
    sha256: "2bd596bbfc4a275ceb8721a5954ee97daea5ebe673e96a185ebd732f6fb023ac",
    archiveRoot: "node-v22.22.0-darwin-arm64",
  },
  "windows-amd64": {
    archive: "node-v22.22.0-win-x64.zip",
    sha256: "c97fa376d2becdc8863fcd3ca2dd9a83a9f3468ee7ccf7a6d076ec66a645c77a",
    archiveRoot: "node-v22.22.0-win-x64",
  },
} as const;
```

- [x] **Step 2: Implement safe download, extraction, and validation**

Download with HTTPS redirect support and a bounded timeout into a sibling temporary directory. Verify SHA-256 before extracting. Use `/usr/bin/tar -xJf` for macOS and non-interactive PowerShell `Expand-Archive` for Windows. Require the single expected archive root, `node --version === v22.22.0`, and the platform npm CLI path before atomic rename.

- [x] **Step 3: Implement concurrent installation locking**

Use exclusive `<version>.lock` creation, a wait window longer than the download timeout, stale-lock recovery, post-wait runtime revalidation, and owner-only cleanup. Never delete another version or a user system Node.

- [x] **Step 4: Add focused manager tests**

Use real temporary directories with injected downloader/extractor/runner. Cover asset selection, unsupported platforms, cached reuse, successful activation, checksum rejection, wrong archive root, wrong version, failed cleanup, concurrent callers performing one download, and stale lock recovery.

### Task 2: Early CLI Node Preflight and Re-exec

**Files:**
- Create: `packages/cli/bin/node-preflight.mjs`
- Create: `packages/cli/src/node-preflight.test.ts`
- Modify: `packages/cli/bin/agentroam.mjs`
- Modify: `packages/cli/package.json`
- Modify: `packages/cli/src/platform.ts`
- Modify: `packages/cli/src/platform.test.ts`

**Interfaces:**
- Produces: `runNodePreflight({ argv, nodeVersion, platform, arch, launcherPath, environment }): Promise<boolean>` where `true` means a managed child handled execution and the regular CLI must not import.
- Consumes: `ensureManagedNode`, minimal `--data-dir` parsing, child spawn, `AGENTROAM_MANAGED_NODE` re-entry marker.

- [x] **Step 1: Separate platform support from Node major validation**

Keep `detectPlatform()` authoritative after preflight under Node 22, and add a platform-only target helper used before re-exec. Preserve all current Node 22 and unsupported-platform tests.

- [x] **Step 2: Add the pre-import launcher decision**

Implement this entry structure:

```js
const { handled } = await import("./node-preflight.mjs").then((module) => module.runNodePreflight(...));
if (!handled) {
  const { main } = await import("../dist/cli.js");
  await main(process.argv.slice(2));
}
```

Node 22 returns immediately. Node 18+ parses `--data-dir`, installs/resolves private Node, spawns it with `[launcherPath, ...argv]`, inherits stdio, forwards termination signals, and mirrors exit code/signal. Node below 18 emits the standalone installer command. A mismatched process carrying `AGENTROAM_MANAGED_NODE=22.22.0` fails instead of looping.

- [x] **Step 3: Package the bootstrap files**

Add `install` to CLI `files`, ensure `dist/node-runtime-manager.js` and `bin/node-preflight.mjs` are included by prepack, and keep `engines.node` as the supported final runtime contract.

- [x] **Step 4: Test preflight decisions and child lifecycle**

Cover Node 22 pass-through, Node 18/20/24/25 managed re-exec, `--data-dir`, re-entry-loop rejection, Node below 18 instructions, inherited stdio, environment marker, exit code propagation, and signal forwarding through injected dependencies.

### Task 3: No-Node Shell and PowerShell Installers

**Files:**
- Create: `packages/cli/install/install-agentroam.sh`
- Create: `packages/cli/install/install-agentroam.ps1`
- Create: `packages/cli/install/README.md`
- Create: `packages/cli/src/install-script-contract.test.ts`

**Interfaces:**
- Consumes: `AGENTROAM_DATA_DIR`, official Node archive URLs, embedded manifest values, exact `agentroam@0.2.0-preview.9`, and npm registry `https://registry.npmjs.org`.
- Produces: verified private Node when required, versioned private AgentRoam launcher, and an atomic user wrapper.

- [x] **Step 1: Implement the macOS arm64 installer**

Use `uname`, `command -v`, `curl`, `shasum`, `/usr/bin/tar`, `mktemp`, `mkdir` lock, and quoted argument arrays. Reuse system Node 22; otherwise install verified private Node. Run npm through the selected Node, install exact AgentRoam into a temporary launcher prefix, validate `agentroam version`, rename it into `<dataDir>/launcher/0.2.0-preview.9`, and atomically write `~/.local/bin/agentroam`.

- [x] **Step 2: Implement the Windows x64 installer**

Use PowerShell `Invoke-WebRequest`, `Get-FileHash`, `Expand-Archive`, exclusive lock-file creation, and `System.Diagnostics.Process` or call operator argument arrays. Reuse system Node 22 or activate verified private Node, install exact AgentRoam, write `%USERPROFILE%\.agentroam\bin\agentroam.cmd` atomically, and add only that directory to the user PATH when absent.

- [x] **Step 3: Document versioned Release usage**

Document exact Gitee Release commands for `install-agentroam.sh` and `install-agentroam.ps1`, data-path overrides, wrapper locations, PATH behavior, and uninstall boundaries. State that installers never modify system Node.

- [x] **Step 4: Add script contract tests**

Read both scripts as text and assert Node version, archive names, SHA-256, npm registry, AgentRoam package version, data directories, wrapper paths, and absence of system package-manager/admin installation commands. Run `sh -n` for the POSIX script when available.

### Task 4: Release Collection, Audit, and CI Verification

**Files:**
- Modify: `scripts/collect-cli-artifacts.mjs`
- Modify: `scripts/audit-cli-tarball.mjs`
- Modify: `scripts/verify-cli-install.mjs`
- Modify: `.github/workflows/cli-release.yml`
- Modify: `.github/workflows/cli-release-verify.yml`

**Interfaces:**
- Consumes: source installers, packaged preflight/manager, release package version.
- Produces: `dist/cli-release/install-agentroam.sh`, `install-agentroam.ps1`, SHA256SUMS entries, tarball audit guarantees, and platform bootstrap smoke checks.

- [x] **Step 1: Collect and checksum standalone installers**

Copy both installer files after package tarballs, preserve executable mode for Shell, and add their SHA-256 lines to the sorted `SHA256SUMS` output.

- [x] **Step 2: Extend launcher tarball audit**

Allow and require `package/install/`, `package/bin/node-preflight.mjs`, and `package/dist/node-runtime-manager.js`. Reject native executables, archives, temporary runtime directories, or expanded Node distributions inside the launcher tarball.

- [x] **Step 3: Extend fresh-install verification**

Add `--bootstrap-script` verification helpers so macOS can run the Shell installer in an isolated HOME/data directory and Windows can run the PowerShell installer in an isolated USERPROFILE/data directory. Support a local archive fixture or injected download URL for deterministic CI while retaining production checksum checks.

- [x] **Step 4: Wire CI bootstrap checks**

On macOS, verify wrong-Node re-exec and Shell syntax/contract. On Windows, execute the collected PowerShell installer with isolated paths and verify the resulting Node 22, wrapper, CLI version, SQLite, and ConPTY smoke before artifact acceptance.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run:

```bash
/Users/caoqu/.nvm/versions/node/v22.22.0/bin/node node_modules/vitest/vitest.mjs run packages/cli/src
/Users/caoqu/.nvm/versions/node/v22.22.0/bin/node node_modules/typescript/bin/tsc --noEmit -p packages/cli/tsconfig.json
/Users/caoqu/.nvm/versions/node/v22.22.0/bin/node node_modules/vitest/vitest.mjs run
npm run pack:launcher
node scripts/verify-cli-install.mjs --artifacts dist/cli-release --node /Users/caoqu/.nvm/versions/node/v22.22.0/bin/node
git diff --check
```

Expected: CLI and full repository tests pass under Node 22, launcher packaging/audit passes, the macOS isolated bootstrap smoke succeeds, and no whitespace errors remain. Windows PowerShell execution must pass in CI; if a local Windows host is unavailable, report that real-machine result as pending rather than inferring it from macOS.
