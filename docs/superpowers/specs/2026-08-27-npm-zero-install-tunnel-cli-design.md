# NPM Zero-Install Tunnel CLI Design

**Date:** 2026-08-27
**Status:** Approved design
**Project:** customer-agent

## 1. Goal

Publish the Customer Agent remote Web console as an npm CLI with this primary experience:

```bash
npx customer-agent
```

The CLI starts the local production Web/PTY server, creates an outbound HTTPS tunnel, prints a QR code, and lets a phone connect from any network without installing a VPN, configuring port forwarding, or installing a tunnel client separately.

## 2. Supported Platforms

First release:

- macOS 12 or newer, Apple Silicon arm64;
- macOS 12 or newer, Intel x64;
- Windows 10/11 x64;
- Node.js 22.x.

Not supported in the first release:

- Windows 7/8;
- Windows ARM64;
- Linux;
- Bun as the consumer runtime;
- Android/iOS native applications.

## 3. Package Scope

The public package contains only the CLI and headless Web-console runtime.

Included:

```text
packages/cli
packages/server production runtime
packages/core compiled runtime
packages/tui (optional customer-agent TUI command)
node-pty
better-sqlite3
cloudflared downloader/launcher
QR renderer
```

Excluded:

```text
packages/desktop
Electron
desktop renderer and icons
voice wake/ASR/TTS helpers
packages/sdk
.env.local
.next-dev
.sessions
database files
logs and local model credentials
```

The package should be named `customer-agent` when the unscoped npm name is available. If unavailable, publishing uses a scoped package while preserving the binary name `customer-agent`.

## 4. Package Layout

```text
packages/cli/
  package.json
  bin/customer-agent.mjs
  src/cli.ts
  src/args.ts
  src/runtime-manager.ts
  src/process-supervisor.ts
  src/port.ts
  src/qr.ts
  src/doctor.ts
  src/platform.ts
  src/pairing.ts
  src/tunnel/
    tunnel-provider.ts
    cloudflare-provider.ts
    custom-command-provider.ts
  src/cloudflared/
    installer.ts
    manifest.ts
    checksum.ts
  runtime/
    ws-server.mjs
    .next/standalone/
    .next/static/
    core/dist/
```

`packages/cli/package.json`:

- is public;
- declares `engines.node: >=22 <23`;
- declares `os: [darwin, win32]`;
- declares `cpu: [arm64, x64]` while runtime rejects win32-arm64;
- exposes `customer-agent` through `bin`;
- uses a strict `files` whitelist;
- declares native runtime dependencies directly;
- has no workspace dependency on private `@agent/core`.

## 5. Build and Publication

Consumers do not run Bun or Next build.

Release build:

1. Install the monorepo with Bun in CI.
2. Build `packages/core/dist` for Node.
3. Build Next.js with `output: "standalone"` into the production `.next` directory.
4. Copy `.next/standalone`, `.next/static`, custom `ws-server.mjs`, and compiled core into `packages/cli/runtime`.
5. Ensure native dependencies remain external and declared by the CLI package.
6. Build CLI TypeScript into Node ESM.
7. Run `npm pack --dry-run` and inspect the exact file list.
8. Install the generated tarball in clean platform test jobs.
9. Publish with npm 2FA and provenance.

The repository lockfile is not shipped as the consumer install contract because it currently references a private registry. Public npm metadata contains portable semver dependencies.

## 6. CLI Commands

Default:

```bash
npx customer-agent
```

Equivalent:

```bash
customer-agent start --relay cloudflare --root .
```

Commands and flags:

```text
customer-agent start
  --root <path>             repeatable; defaults to process.cwd()
  --port <number>           default: automatic free port
  --relay cloudflare        default
  --relay custom
  --tunnel-command <cmd>    custom command with {port} placeholder
  --local-only              do not create public tunnel
  --no-qr                   print URL without terminal QR
  --data-dir <path>         default: ~/.customer-agent

customer-agent doctor
customer-agent version
```

The first release is a foreground process. It does not install launchd, Windows services, startup agents, or daemons.

## 7. Runtime Directories

Default persistent directory:

```text
~/.customer-agent/
  data/.agent-data/agent.db
  bin/cloudflared[.exe]
  cache/
  logs/
```

The CLI always sets `AGENT_DATA_DIR=~/.customer-agent/data` unless overridden. npm cache eviction, package upgrade, or `npx` temporary directories never remove accounts, terminal metadata, command history, or preferences.

The default filesystem root is the directory from which the CLI was started. The CLI does not expose the entire home directory unless the user explicitly passes it through `--root`.

## 8. Startup Flow

```text
CLI start
  → validate Node 22 and supported platform/architecture
  → validate node-pty and better-sqlite3 can load
  → create runtime/data/cache/log directories
  → normalize and validate allowed roots
  → choose requested or available local port
  → start bundled production ws-server on 127.0.0.1
  → poll /api/web-auth/status until healthy
  → if local-only: print local URL and optional QR
  → otherwise acquire cloudflared
  → start outbound tunnel to local server
  → parse public HTTPS URL
  → register trusted forwarded HTTPS origin
  → generate pairing URL when setup is required
  → print URL and QR
  → wait while supervising both child processes
```

Shutdown:

```text
SIGINT/SIGTERM
  → stop accepting new tunnel traffic
  → terminate cloudflared process tree
  → stop WebSocket/PTY server gracefully
  → force remaining child processes after timeout
  → exit with deterministic status code
```

## 9. Tunnel Provider Interface

```ts
export interface TunnelStartOptions {
  localUrl: string;
  signal: AbortSignal;
  log: (line: string) => void;
}

export interface TunnelHandle {
  publicUrl: string;
  close(): Promise<void>;
  exited: Promise<{ code: number | null; signal: string | null }>;
}

export interface TunnelProvider {
  start(options: TunnelStartOptions): Promise<TunnelHandle>;
}
```

### 9.1 Cloudflare Provider

Default provider runs:

```text
cloudflared tunnel --no-autoupdate --url http://127.0.0.1:<port>
```

It parses the first valid `https://*.trycloudflare.com` URL from stdout/stderr and rejects URLs from unrelated log lines.

The cloudflared binary is downloaded on first use and cached. The manifest maps:

```text
darwin-arm64
darwin-amd64
windows-amd64.exe
```

Each CLI release pins a cloudflared version, download URL, size, and SHA-256. A missing or mismatched checksum aborts tunnel startup and removes the downloaded file.

### 9.2 Custom Command Provider

`--relay custom --tunnel-command '<command with {port}>'` runs a user-supplied tunnel command. The provider substitutes only the validated numeric port and parses a public HTTPS URL from output. It does not invoke through a shell unless required by the platform; argument-array execution is preferred.

This provider supports self-hosted relay tools without coupling the Web console to one relay protocol.

## 10. Pairing and Authentication

### 10.1 First Run

When `/api/web-auth/status` reports `needsSetup: true`:

1. Generate a cryptographically random 32-byte pairing secret.
2. Pass only its SHA-256 hash and five-minute expiry to the local server.
3. Put the raw secret in the QR URL:

```text
https://public.example/web?pair=<base64url-secret>
```

4. Setup requires the pairing value and consumes it once.
5. Creating the administrator permanently disables first-user setup.

The public URL cannot be claimed by an unaffiliated scanner without the pairing URL. The QR never includes username or password.

### 10.2 Subsequent Runs

When a user already exists, the QR contains only `/web`. The user logs in with username and password and receives the existing 30-day HttpOnly session cookie.

### 10.3 Forwarded HTTPS

The local Gateway trusts forwarded host/proto only when the direct peer is the locally launched tunnel client. Cookie `Secure`, expected Origin, and WebSocket checks use the trusted forwarded HTTPS values. Arbitrary network clients cannot spoof forwarded headers.

## 11. Cross-Platform Runtime

### 11.1 macOS

- PTY: node-pty forkpty.
- Default shell: `$SHELL`, fallback `/bin/zsh`.
- Cwd: process group + `ps` + `lsof`, with OSC 7 fallback.
- Command history: zsh preexec private OSC event.
- Process cleanup: process groups and signals.

### 11.2 Windows 10/11 x64

- PTY: node-pty ConPTY.
- Default shell: PowerShell (`pwsh.exe`, fallback `powershell.exe`).
- Cwd: OSC 7 emitted by PowerShell shell integration; Windows has no supported external process-cwd API equivalent to lsof.
- Command history: PSReadLine `AddToHistoryHandler` emits private OSC command events while retaining normal PowerShell history behavior.
- Process cleanup: Windows process tree termination.
- Paths and root lists use Node path APIs and `path.delimiter`.
- Cloudflared executable ends in `.exe`.

Windows 7/8 and winpty are out of scope.

## 12. QR Output

The CLI prints:

- local URL;
- public URL;
- whether setup pairing is active and its remaining lifetime;
- a terminal QR using UTF-8 block output;
- a short security notice;
- Ctrl+C shutdown instructions.

`--no-qr` suppresses only the QR. The URL is always printed.

## 13. Error Handling

- Unsupported Node/platform: fail before creating child processes.
- Native addon load failure: identify module, ABI, runtime, and remediation through `doctor`.
- Local port occupied: automatically choose the next available port unless an explicit port was requested, in which case fail.
- Local server health timeout: print server log location and terminate tunnel startup.
- Cloudflared download failure: keep local service available and suggest retry, `--local-only`, or custom relay.
- Checksum mismatch: delete binary and abort public tunnel.
- Cloudflare blocked: retry three times with bounded backoff, then degrade to local-only.
- Tunnel exits after startup: keep local service alive and clearly mark public access unavailable.
- Local server exits: immediately terminate tunnel.
- Invalid pairing token: deny setup without revealing whether a username exists.
- Signal shutdown: idempotent child cleanup with forced timeout fallback.

## 14. Security and Privacy

- Public transport is HTTPS/WSS only.
- Default root is current directory, not the whole home directory.
- QR pairing secrets expire in five minutes and are single-use.
- QR URLs contain no long-lived credentials.
- Login rate limiting and user ownership remain enforced.
- No analytics or telemetry are collected.
- Tunnel logs redact pairing values, cookies, authorization headers, command content, and file names.
- Published tarballs cannot include local configuration or data.
- Company users must follow their employer's policy before tunneling internal files or terminals through a third-party service.

## 15. CI and Release Tests

Matrix:

```text
macos-14 / Node 22 / arm64 validation
macos-13 / Node 22 / x64 build or emulated validation
windows-2022 / Node 22 / x64
```

Required tests:

- CLI argument parsing and defaults;
- platform/architecture mapping;
- free-port selection;
- native addon load and simple PTY round trip;
- SQLite initialization and login;
- production Web server health check;
- Cloudflared download URL and checksum verification;
- tunnel URL parsing from interleaved output;
- retry and local-only degradation;
- pairing token issuance, expiry, and single-use consumption;
- forwarded HTTPS Origin and Secure cookie handling;
- QR payload correctness;
- SIGINT/SIGTERM child cleanup;
- npm tarball file whitelist;
- install generated tarball in a clean directory and execute smoke test;
- macOS zsh cwd/history integration;
- Windows ConPTY/PowerShell cwd/history integration.

External Quick Tunnel E2E runs as a scheduled or release-gate test rather than on every pull request.

## 16. Delivery Phases

1. Add standalone server release staging and public package boundaries.
2. Implement Node CLI, process supervision, port selection, and local-only mode.
3. Implement cloudflared download, checksum manifest, tunnel provider, and QR output.
4. Add one-time pairing and trusted forwarded HTTPS handling.
5. Add Windows ConPTY/PowerShell integration and Windows CI.
6. Add custom command relay provider, packaging audit, and release automation.

Each phase must produce an installable tarball and pass its platform-appropriate smoke tests before the next phase starts.
