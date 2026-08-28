# AgentRoam Bundled Relay Fallback Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship AgentRoam with a platform-specific cloudflared npm dependency and select Cloudflare, Pinggy 443, or LAN in order without runtime GitHub access.

**Architecture:** A small `agentroam-cloudflared-darwin-arm64` package owns the verified upstream archive. The main CLI extracts that archive into its persistent cache, starts providers through a common interface, verifies the public health endpoint, and falls through to Pinggy and then RFC1918 LAN access.

**Tech Stack:** Node.js 22 ESM, TypeScript, Vitest, npm tarballs, OpenSSH reverse forwarding, cloudflared 2026.8.2, Next.js standalone runtime.

## Global Constraints

- Main version: `agentroam@0.2.0-preview.3`.
- Platform package: `agentroam-cloudflared-darwin-arm64@0.2.0-preview.3`.
- Supported consumer platform: macOS arm64 with Node.js `>=22 <23`.
- Default order: Cloudflare -> Pinggy over outbound SSH 443 -> RFC1918 LAN.
- Runtime startup must not download cloudflared from GitHub.
- Cloudflared upstream archive SHA-256: `9042c2c5d8b2de78e60f313d5fb31b6c5c1cebde787a3caf1f2c9588084ac442`.
- Do not update the main package `latest` dist-tag.
- Do not commit or push.

---

### Task 1: Platform Cloudflared Package

**Files:**
- Create: `packages/cloudflared-darwin-arm64/package.json`
- Create: `packages/cloudflared-darwin-arm64/README.md`
- Create: `packages/cloudflared-darwin-arm64/manifest.json`
- Create: `packages/cloudflared-darwin-arm64/vendor/cloudflared-darwin-arm64.tgz`
- Create: `scripts/fetch-cloudflared-package.mjs`
- Create: `scripts/audit-cloudflared-tarball.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: official cloudflared 2026.8.2 darwin-arm64 release archive.
- Produces: package exports `./manifest.json` and `./archive`, each resolvable with `createRequire().resolve()`.

- [ ] **Step 1: Add the platform package metadata and manifest**

Use exact platform metadata and exports:

```json
{
  "name": "agentroam-cloudflared-darwin-arm64",
  "version": "0.2.0-preview.3",
  "os": ["darwin"],
  "cpu": ["arm64"],
  "files": ["README.md", "manifest.json", "vendor/cloudflared-darwin-arm64.tgz"],
  "exports": {
    "./manifest.json": "./manifest.json",
    "./archive": "./vendor/cloudflared-darwin-arm64.tgz"
  }
}
```

- [ ] **Step 2: Add the deterministic acquisition script**

`scripts/fetch-cloudflared-package.mjs` downloads only the manifest URL, writes a temporary file, validates byte size and SHA-256, and atomically renames it into `vendor/`. It accepts `HTTPS_PROXY`/`HTTP_PROXY` by invoking `curl --proxy <url>` only when the variable is set; otherwise it invokes `curl` directly.

- [ ] **Step 3: Fetch and audit the upstream archive**

Run the acquisition script with `HTTPS_PROXY=http://127.0.0.1:7897`. The audit script opens the generated npm tarball, validates name/version/os/cpu/exports, checks the nested archive size/hash, and rejects files outside the whitelist.

- [ ] **Step 4: Add root package scripts**

Expose `fetch:cloudflared`, `pack:cloudflared`, and a combined `pack:cli` that creates and audits the platform tarball before the main tarball.

### Task 2: Offline Cloudflared Resolver

**Files:**
- Modify: `packages/cli/package.json`
- Modify: `packages/cli/src/cloudflared/manifest.ts`
- Create: `packages/cli/src/cloudflared/bundled-asset.ts`
- Modify: `packages/cli/src/cloudflared/installer.ts`
- Modify: `packages/cli/src/cloudflared/installer.test.ts`

**Interfaces:**
- Consumes: `resolveBundledCloudflared(target): Promise<BundledCloudflaredAsset | null>`.
- Produces: `ensureCloudflared(target, dataDir): Promise<string>` with resolver order cache -> bundled archive -> PATH -> error.

- [ ] **Step 1: Define the bundled asset contract**

```ts
export interface BundledCloudflaredAsset {
  archivePath: string;
  sha256: string;
  size: number;
  fileName: string;
  version: string;
}
```

Resolve `agentroam-cloudflared-darwin-arm64/manifest.json` and `/archive` through `createRequire(import.meta.url)`. Return `null` only for `MODULE_NOT_FOUND`; surface malformed manifests.

- [ ] **Step 2: Replace runtime download with verified extraction**

Validate the installed archive using `stat` and `sha256File`, extract into a unique temporary directory below `<dataDir>/bin`, require one regular `cloudflared` file, set `0755`, and atomically rename it to `<dataDir>/bin/cloudflared`. Always remove the temporary directory.

- [ ] **Step 3: Preserve cache and PATH fallback behavior**

Cache markers contain the upstream archive SHA-256. When bundled resolution or validation fails, try an executable on `PATH`; if none exists, throw an error that includes both causes without attempting GitHub.

- [ ] **Step 4: Add focused resolver tests**

Inject a bundled-asset resolver into `ensureCloudflared` for tests. Cover verified extraction, executable permission, cache reuse, checksum rejection with PATH fallback, missing package with PATH fallback, and final actionable failure.

### Task 3: Public Provider Readiness and Pinggy

**Files:**
- Create: `packages/cli/src/tunnel/public-readiness.ts`
- Create: `packages/cli/src/tunnel/public-readiness.test.ts`
- Create: `packages/cli/src/tunnel/pinggy-provider.ts`
- Create: `packages/cli/src/tunnel/pinggy-provider.test.ts`
- Modify: `packages/cli/src/tunnel/cloudflare-provider.ts`
- Modify: `packages/cli/src/tunnel/custom-command-provider.ts`

**Interfaces:**
- Consumes: existing `TunnelProvider.start({ localUrl, signal, log })`.
- Produces: `waitForPublicReadiness(publicUrl, options): Promise<void>` and `PinggyTunnelProvider(port, dataDir)`.

- [ ] **Step 1: Implement bounded public readiness**

```ts
export interface ReadinessOptions {
  timeoutMs?: number;
  intervalMs?: number;
  fetchImpl?: typeof fetch;
}

export async function waitForPublicReadiness(
  publicUrl: string,
  options?: ReadinessOptions,
): Promise<void>;
```

Probe `/api/web-auth/status`, require HTTP 200 and a JSON object containing boolean `authenticated` and `needsSetup`, retry transient failures, and include the last status/error on timeout.

- [ ] **Step 2: Add Pinggy process startup and URL parsing**

Spawn `ssh` with port 443, `ExitOnForwardFailure=yes`, `ServerAliveInterval=30`, `ServerAliveCountMax=3`, `StrictHostKeyChecking=accept-new`, and an AgentRoam-owned known-hosts file. Parse only `https://<name>.pinggy-free.link`, redact pairing values, and close the SSH process on abort or provider fallback.

- [ ] **Step 3: Make provider startup failures clean up children**

Cloudflare, Pinggy, and custom providers must terminate their child when URL parsing or readiness fails. Do not leave a child running after a rejected `start()` call.

- [ ] **Step 4: Add focused readiness and Pinggy tests**

Cover transient 530 -> success, invalid JSON shape, timeout diagnostics, accepted/rejected Pinggy URLs, exact SSH options, abort cleanup, and startup failure cleanup using injected `spawn`/fetch functions.

### Task 4: Relay Orchestration and CLI Contract

**Files:**
- Modify: `packages/cli/src/args.ts`
- Modify: `packages/cli/src/args.test.ts`
- Create: `packages/cli/src/tunnel/relay-orchestrator.ts`
- Create: `packages/cli/src/tunnel/relay-orchestrator.test.ts`
- Modify: `packages/cli/src/cli.ts`
- Modify: `packages/cli/README.md`
- Modify: `packages/cli/RELEASE.md`

**Interfaces:**
- Consumes: `CliOptions.relay: "auto" | "cloudflare" | "pinggy" | "custom"`.
- Produces: `selectRelay(options): Promise<{ tunnel: TunnelHandle | null; publicUrl: string; provider: string }>`.

- [ ] **Step 1: Extend relay argument parsing**

Set the default relay to `auto`, accept `auto`, `cloudflare`, `pinggy`, and `custom`, preserve the custom-command requirement, and keep `--local-only` authoritative.

- [ ] **Step 2: Implement ordered provider selection**

`auto` tries Cloudflare then Pinggy; explicit provider modes try only their named provider. Every started public provider must pass readiness before selection. Close failed handles and use the RFC1918 URL when no public provider succeeds.

- [ ] **Step 3: Integrate the orchestrator into the CLI**

Update version output to `0.2.0-preview.3`, print each provider attempt/failure, print exactly one final URL/QR, preserve pairing redaction, and close the selected provider plus local runtime on signals.

- [ ] **Step 4: Add orchestration tests and public documentation**

Test Cloudflare success, Cloudflare -> Pinggy fallback, dual failure -> LAN, explicit provider behavior, and local-only bypass. Document the bundled package, Pinggy 60-minute/one-time-screen limitations, and all relay flags.

### Task 5: Packaging, Smoke, and Preview Publication

**Files:**
- Modify: `scripts/audit-cli-tarball.mjs`
- Modify: `scripts/verify-cli-install.mjs`
- Modify: `scripts/verify-cli-tunnel.mjs`
- Modify: `.github/workflows/cli-release.yml`
- Modify: `.github/workflows/cli-release-verify.yml`
- Create: `packages/cloudflared-darwin-arm64/agentroam-cloudflared-darwin-arm64-0.2.0-preview.3.tgz`
- Create: `packages/cli/agentroam-0.2.0-preview.3.tgz`

**Interfaces:**
- Consumes: the two exact preview.3 tarballs.
- Produces: audited npm packages and verified official-registry preview releases.

- [ ] **Step 1: Synchronize versioned scripts and CI metadata**

Audit the main package's exact optional dependency and preview.3 identity. Update clean-install verification to install both local tarballs without GitHub access and prove that `doctor`, local health, LAN URL, better-sqlite3, real zsh PTY, and bundled cloudflared extraction succeed.

- [ ] **Step 2: Run all affected unit tests once development is complete**

Run the CLI tests and the existing SQLite auth/web-console tests under Node 22. Fix failures and rerun the complete affected set.

- [ ] **Step 3: Build, pack, and audit both artifacts**

Run the Node 22 build pipeline, pack the platform package first, pack the main package second, audit exact contents/hashes/native architectures, and confirm each `.tgz` is below 30 MB.

- [ ] **Step 4: Run real provider verification**

Verify Cloudflare public health/pairing/WSS. If Cloudflare remains blocked, prove automatic Pinggy selection, browser screening continuation, pairing, Secure Cookie, nonce, and WSS hello. Force both failures and confirm LAN QR fallback. Confirm Ctrl+C leaves no child processes.

- [ ] **Step 5: Publish and verify preview.3**

Publish `agentroam-cloudflared-darwin-arm64@0.2.0-preview.3` first and `agentroam@0.2.0-preview.3` second to the official registry under `preview`, completing WebAuthn as required. Wait for automated validation, verify dist-tags and metadata, and run an empty-cache official-registry install. Keep `latest=0.2.0-preview.1`.

## Final Unit Test Verification

- [ ] **Main agent: run affected unit tests after development is complete**

Run:

```bash
/Users/caoqu/.nvm/versions/node/v22.22.0/bin/node node_modules/vitest/vitest.mjs run \
  packages/cli/src \
  packages/core/src/infrastructure/SQLiteAuthStore.test.ts \
  packages/core/src/infrastructure/SQLiteWebConsoleStore.test.ts
```

Expected: all selected tests pass under Node 22.22.0.

If a test fails, fix the implementation or test and rerun this command until it passes. Report the command and result in the final response.
