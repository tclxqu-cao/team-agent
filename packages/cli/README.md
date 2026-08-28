# AgentRoam

Zero-install mobile remote terminal and file console. **No desktop app, no VPN** — scan a QR code and open the web console from your phone.

## Requirements

- **Node.js 22** (required)
- macOS arm64

> Preview status: `0.2.0-preview.3` is intentionally limited to macOS arm64.
> macOS x64 and Windows x64 remain future formal-release targets.

## Quick start

```bash
npx agentroam@preview
```

Or install from tarball:

```bash
npm install ./agentroam-cloudflared-darwin-arm64-0.2.0-preview.3.tgz ./agentroam-0.2.0-preview.3.tgz
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
```

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

The macOS arm64 cloudflared binary is installed from npm as a verified platform package, so startup does not download from GitHub. If Cloudflare cannot connect, automatic mode tries Pinggy over outbound SSH port 443. Pinggy free tunnels last up to 60 minutes and may show a one-time security confirmation in the phone browser. If neither public relay works, the QR code uses a LAN address and the phone must be on the same local network.

## What's included

- Next.js **standalone** web gateway + WebSocket PTY server
- `@agent/core` bundled runtime
- Optional platform **cloudflared** package (verified size + SHA-256 before execution)
- **Pairing token** + secure cookies behind HTTPS tunnel

Not included: Electron desktop app, SDK, dev `.env`, session caches.

## Release verification (maintainers)

```bash
npm run fetch:cloudflared
npm run pack:cli
node scripts/verify-cli-install.mjs --node /path/to/node22
node scripts/verify-cli-tunnel.mjs --node /path/to/node22 --provider auto
```

Windows ConPTY remains a formal-release target and is not included in this preview.
