# NPM Zero-Install Tunnel CLI Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a macOS and Windows npm CLI that starts the bundled Customer Agent Web console, creates a Cloudflare Quick Tunnel, and prints a one-time pairing QR so a phone can connect without VPN installation.

**Architecture:** A new public `packages/cli` package supervises a bundled Next standalone runtime and pluggable tunnel provider. Cloudflared is downloaded and checksum-verified per platform; first setup is protected by a five-minute pairing secret. Platform-specific PTY, cwd, history, and process cleanup behavior is isolated behind runtime adapters.

**Tech Stack:** Node.js 22 ESM, TypeScript, Next.js standalone output, node-pty/ConPTY, better-sqlite3, Cloudflare Quick Tunnel, qrcode-terminal, Vitest, GitHub Actions.

## Global Constraints

- Consumer runtime is Node.js `>=22 <23`; consumers do not install Bun.
- Supported platforms are macOS 12+ arm64/x64 and Windows 10/11 x64.
- Desktop/Electron, voice helpers, SDK, local env files, sessions, databases, and logs are excluded from the npm tarball.
- The default allowed filesystem root is `process.cwd()`, not the user's home directory.
- Public access is HTTPS/WSS only; first setup requires a five-minute single-use pairing secret.
- Cloudflare Quick Tunnel is the default; custom command relay remains available.
- User data persists under `~/.customer-agent` independently of npm caches and package versions.
- Cloudflared artifacts are pinned and SHA-256 verified before execution.
- CLI shutdown must clean up tunnel and server process trees on macOS and Windows.

---

### Task 1: Create the Public CLI Package and Argument Contracts

**Files:**
- Create: `packages/cli/package.json`
- Create: `packages/cli/tsconfig.json`
- Create: `packages/cli/bin/customer-agent.mjs`
- Create: `packages/cli/src/args.ts`
- Create: `packages/cli/src/platform.ts`
- Modify: `package.json`
- Unit tests: `packages/cli/src/args.test.ts`, `packages/cli/src/platform.test.ts`

**Interfaces:**
- Produces `CliOptions`, `parseArgs(argv)`, and `detectPlatform()`.
- Later tasks consume normalized roots, relay selection, data directory, and platform target.

```ts
export interface CliOptions {
  command: "start" | "doctor" | "version";
  roots: string[];
  port: number | null;
  relay: "cloudflare" | "custom";
  tunnelCommand: string | null;
  localOnly: boolean;
  qr: boolean;
  dataDir: string;
}
export type PlatformTarget = "darwin-arm64" | "darwin-amd64" | "windows-amd64";
```

- [ ] Inspect root workspace scripts and the existing TUI bin convention.
- [ ] Add `packages/cli` to workspaces and define a public package with binary name `customer-agent`, Node 22 engine, `darwin/win32` OS metadata, `arm64/x64` CPU metadata, and strict files whitelist.
- [ ] Implement `parseArgs(argv): CliOptions` supporting `start`, `doctor`, `version`, repeatable `--root`, `--port`, `--relay`, `--tunnel-command`, `--local-only`, `--no-qr`, and `--data-dir`.
- [ ] Implement `detectPlatform()` returning `darwin-arm64`, `darwin-amd64`, or `windows-amd64`; reject Windows ARM64, Linux, and unsupported Node versions with typed errors.
- [ ] Make the Node shebang bin load the built CLI entry and convert typed errors to stable exit codes.
- [ ] Add focused tests for defaults, repeatable roots, invalid ports, unsupported relay combinations, Node version bounds, and target mapping.

### Task 2: Add Process Supervision, Port Selection, and Local-Only Runtime

**Files:**
- Create: `packages/cli/src/port.ts`
- Create: `packages/cli/src/process-supervisor.ts`
- Create: `packages/cli/src/runtime-manager.ts`
- Create: `packages/cli/src/cli.ts`
- Unit tests: `packages/cli/src/port.test.ts`, `packages/cli/src/process-supervisor.test.ts`, `packages/cli/src/runtime-manager.test.ts`

**Interfaces:**
- Produces `findAvailablePort(requested?)`.
- Produces `ProcessSupervisor.spawn/stopAll`.
- Produces `RuntimeManager.start(options): Promise<RuntimeHandle>` with `localUrl`, `close()`, and `exited`.

```ts
export interface RuntimeHandle {
  port: number;
  localUrl: string;
  dataDir: string;
  close(): Promise<void>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}
```

- [ ] Implement loopback port probing; explicit occupied ports fail, automatic mode scans an OS-assigned port.
- [ ] Implement cross-platform child supervision with abort-signal support, bounded graceful shutdown, macOS process-group signals, and Windows `taskkill /T /F` fallback.
- [ ] Resolve bundled runtime paths relative to the installed CLI, never process cwd.
- [ ] Create `~/.customer-agent/{data,bin,cache,logs}` and set `AGENT_DATA_DIR`, `AGENT_WEB_ROOTS`, `PORT`, `HOST=127.0.0.1`, and production environment.
- [ ] Start the bundled server and poll `/api/web-auth/status` with timeout and child-exit detection.
- [ ] Implement `--local-only`, URL output, and idempotent signal cleanup.
- [ ] Test port conflicts, server readiness, early child exit, signal cleanup, and stable data paths with fake child processes.

### Task 3: Produce a Standalone Server Runtime for the Tarball

**Files:**
- Modify: `packages/server/next.config.js`
- Create: `scripts/stage-cli-runtime.mjs`
- Modify: `packages/cli/package.json`
- Modify: `package.json`
- Unit tests: `scripts/stage-cli-runtime.test.mjs`

**Interfaces:**
- Produces `packages/cli/runtime/ws-server.mjs`, `.next/standalone`, `.next/static`, and bundled core runtime.
- RuntimeManager from Task 2 launches this staged runtime.

- [ ] Enable `output: "standalone"` only for release staging, preserving current dev/prod dist directories.
- [ ] Build core and server, then copy the exact standalone server, static chunks, custom Gateway, and runtime metadata into `packages/cli/runtime`.
- [ ] Rewrite runtime package metadata so private workspace imports resolve inside the tarball while native dependencies remain external CLI dependencies.
- [ ] Fail staging when `BUILD_ID`, standalone server, static assets, Gateway, or core runtime is missing.
- [ ] Add root `build:cli` and CLI `prepack` scripts.
- [ ] Test staging from fixture trees and reject accidental `.env`, database, sessions, desktop, SDK, or source-cache inclusion.

### Task 4: Implement Cloudflared Acquisition and Tunnel Providers

**Files:**
- Create: `packages/cli/src/tunnel/tunnel-provider.ts`
- Create: `packages/cli/src/tunnel/cloudflare-provider.ts`
- Create: `packages/cli/src/tunnel/custom-command-provider.ts`
- Create: `packages/cli/src/cloudflared/manifest.ts`
- Create: `packages/cli/src/cloudflared/checksum.ts`
- Create: `packages/cli/src/cloudflared/installer.ts`
- Unit tests: corresponding `*.test.ts` files

**Interfaces:**
- Produces `TunnelProvider.start(options): Promise<TunnelHandle>`.
- Produces `ensureCloudflared(target, dataDir): Promise<string>`.

```ts
export interface TunnelProvider {
  start(options: { localUrl: string; signal: AbortSignal; log(line: string): void }): Promise<{
    publicUrl: string;
    close(): Promise<void>;
    exited: Promise<{ code: number | null; signal: string | null }>;
  }>;
}
```

- [ ] Define platform-specific pinned release URLs, expected byte sizes, and SHA-256 values for darwin-arm64, darwin-amd64, and windows-amd64.
- [ ] Download to a temporary file, stream SHA-256 calculation, atomically rename on success, chmod on macOS, and remove mismatched files.
- [ ] Revalidate cached binaries before reuse and verify `cloudflared --version` matches the pinned version.
- [ ] Start Quick Tunnel with `--no-autoupdate --url http://127.0.0.1:<port>`, parse only valid trycloudflare HTTPS URLs, and expose close/exited lifecycle.
- [ ] Implement custom command provider with validated `{port}` substitution and HTTPS URL parsing.
- [ ] Add bounded three-attempt Cloudflare retry and local-only degradation.
- [ ] Test interleaved stdout/stderr parsing, checksum mismatch, interrupted download, cache reuse, retries, and custom provider cleanup with fixtures.

### Task 5: Add QR Rendering and One-Time Pairing

**Files:**
- Create: `packages/cli/src/qr.ts`
- Create: `packages/cli/src/pairing.ts`
- Modify: `packages/core/src/infrastructure/SQLiteDatabase.ts`
- Modify: `packages/server/app/api/web-auth/setup/route.ts`
- Modify: `packages/server/app/api/web-auth/status/route.ts`
- Modify: `packages/server/ws-server.mjs`
- Unit tests: `packages/cli/src/pairing.test.ts`, core auth tests, setup route tests

**Interfaces:**
- Produces `createPairingSecret()` with raw token, hash, and expiry.
- Setup consumes the secret exactly once when no user exists.

```ts
export interface PairingSecret {
  token: string;
  hashHex: string;
  expiresAt: string;
}
```

- [ ] Add pairing hash/expiry/consumed persistence or equivalent transaction-safe storage under the stable data directory.
- [ ] Pass only pairing hash/expiry from CLI to the server process.
- [ ] Include raw pairing value in the QR URL only when status reports `needsSetup`.
- [ ] Require and consume pairing in setup before creating the first user; reject expired, reused, missing, and incorrect values uniformly.
- [ ] Render terminal QR with public HTTPS URL, pairing lifetime, local URL, and shutdown notice; `--no-qr` suppresses only QR blocks.
- [ ] Test token entropy, expiry, one-time consumption, QR payload, and subsequent-run URL without pairing.

### Task 6: Make Proxy HTTPS and Origin Validation Tunnel-Aware

**Files:**
- Modify: `packages/server/ws-server.mjs`
- Modify: `packages/server/lib/web-auth/http.ts`
- Create: `packages/server/lib/trusted-proxy.ts`
- Unit tests: `packages/server/lib/trusted-proxy.test.ts`

**Interfaces:**
- Produces trusted forwarded protocol/host resolution for HTTP cookies and WebSocket Origin checks.

- [ ] Trust forwarded headers only when the direct socket peer is loopback and the CLI enables tunnel-proxy mode.
- [ ] Derive Secure cookies from trusted `X-Forwarded-Proto=https`.
- [ ] Validate WebSocket Origin against trusted public forwarded host and explicit allowed origins.
- [ ] Reject spoofed forwarded headers from non-loopback peers.
- [ ] Test local HTTP, forwarded HTTPS, spoofed remote headers, Cloudflare host forms, and custom relay origin forms.

### Task 7: Add macOS and Windows Runtime Adapters

**Files:**
- Create: `packages/server/platform/runtime-adapter.mjs`
- Create: `packages/server/platform/macos-runtime.mjs`
- Create: `packages/server/platform/windows-runtime.mjs`
- Modify: `packages/server/ws-server.mjs`
- Unit tests: `packages/server/platform/*.test.mjs`

**Interfaces:**
- Produces shell selection, cwd observation, shell-history integration, executable names, and process-tree cleanup hooks.

```ts
export interface RuntimeAdapter {
  defaultShell(): Promise<string>;
  shellArgs(historyOsc: boolean): Promise<string[]>;
  observeCwd(pid: number, onCwd: (cwd: string) => void): () => void;
  terminateTree(pid: number): Promise<void>;
}
```

- [ ] Move macOS `ps/lsof/tpgid` and zsh history behavior behind the adapter.
- [ ] Implement Windows shell selection (`pwsh.exe`, then `powershell.exe`) and ConPTY-compatible spawn options.
- [ ] Implement PowerShell OSC 7 cwd reporting and PSReadLine history hook without changing normal PowerShell history behavior.
- [ ] Use Node path APIs and platform delimiters for roots and executable paths.
- [ ] Add Windows process-tree cleanup through `taskkill` and macOS group-signal cleanup.
- [ ] Test adapter selection and generated shell integration scripts with mocked processes on all CI platforms.

### Task 8: Add Doctor Diagnostics and Production CLI Output

**Files:**
- Create: `packages/cli/src/doctor.ts`
- Modify: `packages/cli/src/cli.ts`
- Unit tests: `packages/cli/src/doctor.test.ts`, `packages/cli/src/cli.test.ts`

**Interfaces:**
- Produces human-readable diagnostics and deterministic exit codes.

- [ ] Check Node version, OS/CPU, writable data directory, `node-pty`, `better-sqlite3`, shell availability, cloudflared state, and local port capability.
- [ ] Print module ABI, runtime ABI, and remediation when native modules fail.
- [ ] Print concise startup milestones, local/public URLs, pairing state, QR, logs path, and Ctrl+C instructions without leaking secrets.
- [ ] Keep local service running when Cloudflare fails and clearly report custom/local-only alternatives.
- [ ] Add tests for successful, warning, and fatal diagnostic states and redaction.

### Task 9: Add Packaging Audit and Cross-Platform CI

**Files:**
- Create: `.github/workflows/cli-release.yml`
- Create: `scripts/audit-cli-tarball.mjs`
- Create: `scripts/smoke-cli-tarball.mjs`
- Modify: `packages/cli/package.json`
- Modify: `.gitignore`
- Unit tests: script-level tests or fixtures

**Interfaces:**
- Produces a publishable `.tgz` proven installable on supported platforms.

- [ ] Configure macOS arm64, macOS x64, and Windows x64 Node 22 jobs.
- [ ] Build runtime, run unit tests, `npm pack`, and audit tarball contents against allow/deny lists.
- [ ] Install the generated tarball in a clean temp directory and run `customer-agent doctor` plus local-only health/PTTY/SQLite smoke.
- [ ] Mock Cloudflare in PR jobs and run real Quick Tunnel only as a release or scheduled gate.
- [ ] Publish with npm provenance and require release environment approval/2FA.
- [ ] Document package-name availability handling while preserving binary name `customer-agent`.

## Final Unit Test Verification

- [ ] **Main agent: run affected unit tests after development is complete**

Run:

```bash
bunx vitest run packages/cli packages/core/src/domain/auth packages/core/src/infrastructure/SQLiteAuthStore.test.ts packages/core/src/infrastructure/SQLiteWebConsoleStore.test.ts
bunx tsc --noEmit -p packages/core/tsconfig.json
bunx tsc --noEmit -p packages/cli/tsconfig.json
bunx tsc --noEmit -p packages/server/tsconfig.json
node scripts/audit-cli-tarball.mjs
node scripts/smoke-cli-tarball.mjs
```

Expected: all unit tests and TypeScript checks pass; tarball audit contains no forbidden files; the installed tarball starts a local-only server, passes HTTP health, opens a PTY round trip, and persists SQLite data.

If a test fails, fix the implementation or test and rerun these commands until they pass. Report the exact command and result in the final response.
