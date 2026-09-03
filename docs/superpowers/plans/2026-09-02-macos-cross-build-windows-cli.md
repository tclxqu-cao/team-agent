# AgentRoam macOS Cross-Build Windows CLI Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build universal AgentRoam launcher packages and both macOS arm64 and Windows x64 native runtime packages entirely on macOS, then provide deterministic Windows tarball and registry verification commands.

**Architecture:** `agentroam` becomes a small universal launcher whose platform map resolves exact optional runtime, cloudflared, and TUI packages. A target-driven staging script builds `agentroam-runtime-darwin-arm64` and cross-assembles `agentroam-runtime-win32-x64` from official Node 22 prebuilds; platform audits verify Mach-O or PE files before publication, while a real Windows smoke remains the final runtime gate.

**Tech Stack:** Node.js 22 ESM, TypeScript, npm optional dependencies, Next.js standalone, better-sqlite3 prebuild-install, node-pty prebuilds, Vitest, GitHub Actions.

## Global Constraints

- Supported consumers are macOS arm64 and Windows 10/11 x64 on Node.js `>=22 <23`.
- Build and package assembly run on macOS arm64.
- Windows consumers do not install Bun, Python, Visual Studio Build Tools, or compile native modules.
- Missing official Windows prebuilds fail staging; no `node-gyp` fallback is accepted.
- The public `agentroam` package name and `npx agentroam@preview` entry remain stable.
- Existing uncommitted work must be preserved and integrated, not reverted.
- Windows ARM64, Linux, daemons, and relay behavior changes are out of scope.

---

### Task 1: Centralize Platform Package Resolution

**Files:**
- Create: `packages/cli/src/platform-packages.ts`
- Create: `packages/cli/src/platform-packages.test.ts`
- Modify: `packages/cli/src/cli.ts`
- Modify: `packages/cli/src/runtime-manager.ts`
- Modify: `packages/cli/bin/agent-tui.mjs`

**Interfaces:**
- Consumes: existing `PlatformTarget` from `packages/cli/src/platform.ts`.
- Produces: `AGENTROAM_VERSION`, `PLATFORM_PACKAGES`, `resolvePlatformRuntime(target, requireFromCli?)`, and `resolvePlatformTui(target, requireFromCli?)`.

- [x] **Step 1: Add exact platform metadata and manifest contracts**

```ts
export const PLATFORM_PACKAGES = {
  "darwin-arm64": {
    runtime: "agentroam-runtime-darwin-arm64",
    cloudflared: "agentroam-cloudflared-darwin-arm64",
    tui: "agentroam-tui-darwin-arm64",
  },
  "windows-amd64": {
    runtime: "agentroam-runtime-win32-x64",
    cloudflared: "agentroam-cloudflared-win32-x64",
    tui: "agentroam-tui-win32-x64",
  },
} as const;
```

- [x] **Step 2: Resolve and validate runtime packages before process startup**

```ts
export function resolvePlatformRuntime(target: PlatformTarget, requireFromCli = createRequire(import.meta.url)) {
  const packageName = requirePlatformPackages(target).runtime;
  const manifestPath = requireFromCli.resolve(`${packageName}/manifest.json`);
  const runtimePackageJson = requireFromCli.resolve(`${packageName}/runtime`);
  return validateRuntimeManifest(target, packageName, manifestPath, dirname(runtimePackageJson));
}
```

- [x] **Step 3: Route CLI doctor, RuntimeManager, and agent-tui through the centralized resolver**

Pass the detected target into `RuntimeManager.start`, construct `createRequire` from the resolved runtime `package.json`, and make `bin/agent-tui.mjs` import the compiled platform mapping instead of hardcoding darwin arm64.

- [x] **Step 4: Add focused resolver tests**

Cover valid macOS/Windows manifests, unsupported darwin x64 package mapping, missing optional dependency, package-version mismatch, target mismatch, and TUI entry selection.

### Task 2: Create Universal and Platform Package Topology

**Files:**
- Modify: `package.json`
- Modify: `packages/cli/package.json`
- Create: `packages/runtime-darwin-arm64/package.json`
- Create: `packages/runtime-darwin-arm64/manifest.json`
- Create: `packages/runtime-darwin-arm64/README.md`
- Create: `packages/runtime-win32-x64/package.json`
- Create: `packages/runtime-win32-x64/manifest.json`
- Create: `packages/runtime-win32-x64/README.md`
- Create: `packages/cloudflared-win32-x64/package.json`
- Create: `packages/cloudflared-win32-x64/manifest.json`
- Create: `packages/cloudflared-win32-x64/README.md`
- Create: `packages/tui-win32-x64/package.json`
- Create: `packages/tui-win32-x64/README.md`

**Interfaces:**
- Consumes: exact version and package names from Task 1.
- Produces: npm packages with `os`/`cpu` metadata and stable `./runtime`, `./manifest.json`, `./archive`, and `./entry` exports.

- [x] **Step 1: Make `agentroam` universal**

Remove its `os`, `cpu`, and `runtime` files entry. Add exact optional dependencies for both runtime, cloudflared, and TUI target packages.

- [x] **Step 2: Add runtime package manifests**

```json
{
  "packageVersion": "0.2.0-preview.6",
  "target": "windows-amd64",
  "nodeMajor": 22,
  "nodeModuleAbi": 127,
  "nativeFiles": {}
}
```

The staging task fills `nativeFiles` with target-relative SHA-256 values before packing.

- [x] **Step 3: Add Windows cloudflared package metadata**

Declare `os=["win32"]`, `cpu=["x64"]`, export the executable asset, and record `assetFormat="executable"`, upstream URL, size, and SHA-256 in its manifest.

- [x] **Step 4: Add the Windows TUI package**

Reuse the same Node ESM bundle and bin wrapper as the darwin package while declaring Windows platform metadata.

### Task 3: Implement Target-Driven Cross Staging and Static Native Audits

**Files:**
- Modify: `scripts/stage-cli-runtime.mjs`
- Modify: `scripts/build-tui-package.mjs`
- Create: `scripts/audit-runtime-tarball.mjs`
- Create: `scripts/native-binary.mjs`
- Modify: `scripts/audit-cli-tarball.mjs`
- Modify: `scripts/audit-tui-tarball.mjs`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `--target darwin-arm64|windows-amd64`.
- Produces: staged runtime directories, target manifests with hashes, and target-specific tarball audits.

- [x] **Step 1: Parse an explicit staging target**

```js
const targetName = readRequiredOption("--target");
const target = TARGETS[targetName];
if (!target) throw new Error(`unsupported staging target: ${targetName}`);
```

- [x] **Step 2: Install runtime dependencies for the requested target**

Use `npm install --omit=dev --omit=optional --omit=peer --no-audit --no-fund` with `npm_config_platform=win32`, `npm_config_arch=x64`, `npm_config_target=<Node 22 version>`, and `npm_config_runtime=node` for the Windows stage. Set `npm_config_fallback_to_build=false` and reject install output or artifacts indicating a source build.

- [x] **Step 3: Prune node-pty by target and hash native files**

Retain only `prebuilds/darwin-arm64` or `prebuilds/win32-x64`; require the complete ConPTY file set for Windows and write all critical native hashes to the runtime manifest.

- [x] **Step 4: Implement Mach-O and PE validation**

```js
export function readPeMachine(buffer) {
  if (buffer.readUInt16LE(0) !== 0x5a4d) throw new Error("missing MZ header");
  const peOffset = buffer.readUInt32LE(0x3c);
  if (buffer.readUInt32LE(peOffset) !== 0x00004550) throw new Error("missing PE header");
  return buffer.readUInt16LE(peOffset + 4);
}
```

Require PE machine `0x8664` for Windows and Mach-O arm64 for darwin. Reject cross-platform leakage.

- [x] **Step 5: Make all package audits derive identity and version from package metadata**

The main package audit verifies no runtime files are present and both platform dependency sets use its exact version. Runtime and TUI audits use their package name and manifest target rather than hardcoded preview versions.

### Task 4: Support Windows cloudflared Executable Assets

**Files:**
- Modify: `scripts/fetch-cloudflared-package.mjs`
- Modify: `scripts/audit-cloudflared-tarball.mjs`
- Modify: `packages/cli/src/cloudflared/manifest.ts`
- Modify: `packages/cli/src/cloudflared/bundled-asset.ts`
- Modify: `packages/cli/src/cloudflared/installer.ts`
- Modify: `packages/cli/src/cloudflared/bundled-asset.test.ts`
- Modify: `packages/cli/src/cloudflared/installer.test.ts`

**Interfaces:**
- Consumes: cloudflared package manifest with `assetFormat: "tgz" | "executable"`.
- Produces: `BundledCloudflaredAsset` carrying format and verified target asset path.

- [x] **Step 1: Generalize fetch and audit scripts by package directory**

Accept a package directory argument, read its package and asset manifest, download the declared URL, and validate the declared size/SHA-256 before atomic replacement.

- [x] **Step 2: Add executable asset resolution**

```ts
export interface BundledCloudflaredAsset {
  assetPath: string;
  assetFormat: "tgz" | "executable";
  fileName: string;
  size: number;
  sha256: string;
  version: string;
}
```

- [x] **Step 3: Install Windows assets without external tar**

For `executable`, copy the verified file to a temporary path and atomically rename it to `cloudflared.exe`; preserve the tgz extraction and chmod flow for macOS.

- [x] **Step 4: Test both asset formats and invalid manifests**

Cover tgz extraction, direct executable copy, checksum mismatch, format mismatch, cache reuse, and PATH fallback.

### Task 5: Fix Windows Runtime Behavior

**Files:**
- Modify: `packages/server/ws-server.mjs`
- Modify: `packages/core/src/domain/web-console/WebArtifactBridge.ts`
- Modify: `packages/core/src/domain/web-console/WebArtifactBridge.test.ts`

**Interfaces:**
- Consumes: Windows filesystem paths, PowerShell executables, and node-pty ConPTY.
- Produces: platform-correct server directory resolution, shell selection, tab metadata, cwd reporting, and artifact path validation.

- [x] **Step 1: Resolve the server directory with fileURLToPath**

```js
const dir = path.dirname(fileURLToPath(import.meta.url));
```

- [x] **Step 2: Centralize default shell selection**

On Windows prefer `pwsh.exe`, then `powershell.exe`; on POSIX preserve `$SHELL` and `/bin/zsh`. Use the selected shell for both `pty.spawn` and persisted terminal metadata.

- [x] **Step 3: Keep cwd tracking platform-safe**

Skip `/bin/ps` and `/usr/sbin/lsof` polling on Windows and rely on the existing PowerShell OSC 7 integration.

- [x] **Step 4: Accept validated Windows artifact paths**

Allow drive-letter and UNC absolute paths in the pure browser message parser while retaining NUL/CR/LF rejection and existing POSIX behavior.

- [x] **Step 5: Add focused tests**

Cover POSIX, drive-letter, UNC, relative, control-character, and malformed artifact paths. Exercise shell selection through an exported pure helper or a small dependency-injected server helper.

### Task 6: Add Cross-Platform Pack and Windows Verification Workflows

**Files:**
- Modify: `package.json`
- Modify: `scripts/verify-cli-install.mjs`
- Modify: `scripts/verify-cli-tunnel.mjs`
- Modify: `.github/workflows/cli-release.yml`
- Modify: `.github/workflows/cli-release-verify.yml`
- Modify: `packages/cli/README.md`
- Modify: `packages/cli/RELEASE.md`

**Interfaces:**
- Consumes: all tarballs emitted by Tasks 2-4.
- Produces: `pack:cli:all`, platform-targeted verification, and a Windows job that downloads the exact macOS-built artifact.

- [x] **Step 1: Add deterministic root build and pack commands**

Build shared assets once, stage both runtime targets, fetch both cloudflared assets, pack/audit each platform package, then pack/audit the universal main package. Read versions dynamically instead of embedding filenames.

- [x] **Step 2: Make install smoke platform-aware**

Resolve local tarballs by the detected target. On darwin spawn `/bin/zsh`; on Windows spawn PowerShell with `Write-Output agentroam-pty-ok`, validate SQLite, local health, `/app/`, and process cleanup.

- [x] **Step 3: Split CI into macOS build and Windows verification**

The macOS job uploads universal and Windows tarballs. The Windows job downloads those exact artifacts, installs Node 22, performs local tarball smoke, and never rebuilds or repacks them.

- [x] **Step 4: Update release documentation**

Document supported platforms, macOS cross-build commands, pre-publish Windows smoke, publication order, and post-publish empty-cache Windows verification.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run:

```bash
bunx vitest run packages/cli/src packages/core/src/domain/web-console/WebArtifactBridge.test.ts
bun run --cwd packages/core build
bun run --cwd packages/cli build
npm run pack:cli:all
node scripts/verify-cli-install.mjs --node /path/to/node22
```

Expected: all unit tests and builds pass; every tarball audit passes; local macOS install smoke passes; Windows tarballs pass static PE/x64 audit and are ready for the real Windows smoke job.

If a test fails, fix the implementation or test and rerun this command until it passes. Report the command and result in the final response.
