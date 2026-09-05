# AgentRoam

Zero-install mobile remote terminal and file console. **No desktop app, no VPN** — scan a QR code and open the web console from your phone.

## Requirements

- **Node.js 22** (required)
- macOS arm64 or Windows 10/11 x64

The release is assembled on macOS arm64. Windows does not need Bun, Python,
Visual Studio Build Tools, or `node-gyp`; its prebuilt native runtime is verified
on a real Windows runner before release.

## Quick start

```bash
npx agentroam@preview
```

Or install from tarball:

```bash
npm install ./agentroam-cloudflared-darwin-arm64-0.2.0-preview.13.tgz \
  ./agentroam-runtime-darwin-arm64-0.2.0-preview.13.tgz \
  ./agentroam-tui-darwin-arm64-0.2.0-preview.13.tgz \
  ./agentroam-0.2.0-preview.13.tgz
npx agentroam
```

Windows PowerShell:

```powershell
npm install ./agentroam-cloudflared-win32-x64-0.2.0-preview.13.tgz `
  ./agentroam-runtime-win32-x64-0.2.0-preview.13.tgz `
  ./caoqu-agentroam-tui-win32-x64-0.2.0-preview.13.tgz `
  ./agentroam-0.2.0-preview.13.tgz
npx agentroam
```

On first run:

1. AgentRoam tries a bundled **Cloudflare Quick Tunnel**, then a **Pinggy HTTPS tunnel** over SSH port 443.
2. A **QR code** prints in the terminal — scan it on your phone.
3. Complete **one-time pairing** (5-minute token) and create the admin account.
4. Use the web terminal + file tree remotely.

## Commands

```bash
agentroam                 # start (default)
agentroam doctor          # check native modules + platform
agentroam version
agent-tui                 # start the bundled terminal Agent UI
```

## Install and run in the background

Run the versioned Shell installer on macOS or PowerShell installer on Windows
from the project directory AgentRoam should expose. The installer verifies or
installs Node 22 and the matching CLI, registers the current-user service, starts
it, checks readiness, and prints the access URL. Set `AGENTROAM_ROOT` to select a
different root explicitly. An implicit root equal to the home directory is
rejected.

If the active Node is not 22, the installer checks nvm-sh on macOS and
nvm-windows on Windows, validates every installed candidate, and uses the
highest installed Node 22. It pins that executable for AgentRoam without
changing the user's global or active NVM version. A private Node 22.22.0 is
downloaded only when no installed Node 22 is available.

The service keeps running after the terminal closes, restarts after failure, and
starts again when the user logs in. macOS uses a user LaunchAgent; Windows uses a
current-user Task Scheduler task. Neither requires administrator privileges.
Running a newer versioned installer automatically stops and replaces an existing
AgentRoam user service before starting the new version. Session data, pairing
state, managed runtimes, and service logs are preserved during the upgrade.

```bash
agentroam service status
agentroam service start
agentroam service stop
agentroam service url
agentroam service logs
agentroam service restart
agentroam service uninstall
```

The current phone URL is stored privately at `~/.agentroam/tunnel.url`.
Cloudflared keeps the same Quick Tunnel hostname while its process reconnects;
a full service or computer restart creates a new random hostname. Re-run the
versioned installer after moving or replacing Node/npm so the service receives
the new absolute executable paths.

Both foreground `agentroam start` and the background service prevent idle system
sleep for as long as they run. The display can still dim and turn off normally.
Stopping AgentRoam releases the assertion. Lid close, explicit sleep,
hibernation, shutdown, and low-battery forced sleep remain controlled by the OS.

## Options

| Flag | Description |
|------|-------------|
| `--root <path>` | Workspace root (repeatable). Default: cwd |
| `--local-only` | Skip tunnel; LAN/localhost only |
| `--relay auto` | Cloudflare, then Pinggy, then LAN (default) |
| `--relay cloudflare` | Cloudflare only, then LAN |
| `--relay pinggy` | Pinggy only, then LAN |
| `--relay custom --tunnel-command "<cmd>"` | Your own tunnel command |
| `--no-qr` | Don't print QR code |
| `--port <n>` | Fixed local port |
| `--data-dir <path>` | State directory (default: `~/.agentroam`) |

The platform cloudflared binary is installed from npm after size and SHA-256 verification, so startup does not download from GitHub. If Cloudflare cannot connect, automatic mode tries Pinggy over outbound SSH port 443. Pinggy free tunnels last up to 60 minutes and may show a one-time security confirmation in the phone browser. If neither public relay works, the QR code uses a LAN address and the phone must be on the same local network.

## What's included

- Next.js **standalone** web gateway + WebSocket PTY server
- `@agent/core` bundled runtime
- Optional platform **cloudflared** package (verified size + SHA-256 before execution)
- Optional platform **agent-tui** package (Node 22 bundle; Bun is not required)
- **Pairing token** + secure cookies behind HTTPS tunnel

Not included: Electron desktop app, SDK, dev `.env`, session caches.

## Release verification (maintainers)

```bash
npm run fetch:cloudflared
npm run pack:cli:all
node scripts/verify-cli-install.mjs --artifacts dist/cli-release --node /path/to/node22
node scripts/verify-cli-tunnel.mjs --artifacts dist/cli-release --node /path/to/node22 --provider auto
```

`dist/cli-release` contains seven tarballs plus `SHA256SUMS`. CI uploads this
directory from macOS and downloads the same files on Windows for SQLite,
PowerShell/ConPTY, cloudflared, local server, and webapp smoke tests.
