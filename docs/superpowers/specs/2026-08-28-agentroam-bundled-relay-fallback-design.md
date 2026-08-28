# AgentRoam Bundled Cloudflared and Relay Fallback Design

**Date:** 2026-08-28
**Status:** Approved design
**Project:** customer-agent

## 1. Goal

Make the default AgentRoam startup work without requiring the user to install a tunnel client, configure terminal proxy variables, or install a VPN on the phone.

The supported connection order is:

```text
Cloudflare Quick Tunnel
  -> Pinggy HTTPS tunnel over outbound SSH 443
  -> RFC1918 LAN URL
```

The phone and Mac may use different networks when either public tunnel succeeds. When both public providers fail, a phone on the same LAN can still use the QR code.

## 2. Release Scope

This design targets `agentroam@0.2.0-preview.3` on macOS arm64 with Node.js 22.

Included:

- platform-specific cloudflared npm package;
- offline cloudflared acquisition from the npm install;
- automatic Cloudflare, Pinggy, and LAN fallback;
- public health readiness before QR output;
- provider-specific diagnostics and cleanup;
- local, package, and real-tunnel verification.

Excluded:

- macOS x64 and Windows x64 platform packages;
- stable or custom public domains;
- Pinggy Pro credentials;
- background daemons or unattended reconnect beyond the foreground CLI lifetime;
- changes to the OpenCode virtual direction-key behavior.

## 3. Package Architecture

### 3.1 Main package

`agentroam@0.2.0-preview.3` keeps the CLI, Next standalone runtime, native PTY, SQLite runtime, and QR rendering.

It declares this exact optional dependency:

```json
{
  "optionalDependencies": {
    "agentroam-cloudflared-darwin-arm64": "0.2.0-preview.3"
  }
}
```

The optional dependency is platform-gated by its own npm metadata. Future macOS x64 and Windows x64 packages can use the same resolver contract without growing the main package.

### 3.2 Platform package

`agentroam-cloudflared-darwin-arm64@0.2.0-preview.3` contains only:

```text
package.json
README.md
vendor/cloudflared-darwin-arm64.tgz
manifest.json
```

Package metadata declares:

```json
{
  "os": ["darwin"],
  "cpu": ["arm64"]
}
```

`manifest.json` records the upstream version `2026.8.2`, archive size `19214189`, and SHA-256 `9042c2c5d8b2de78e60f313d5fb31b6c5c1cebde787a3caf1f2c9588084ac442`.

The expected packed sizes are approximately 29 MB for `agentroam` and 19.2 MB for the platform package. Each package remains below the previously successful 29 MB WebAuthn upload envelope instead of publishing one approximately 48 MB artifact.

## 4. Cloudflared Resolution

The main package resolves cloudflared in this order:

1. executable cache whose source checksum matches the platform manifest;
2. exact platform package installed through `optionalDependencies`;
3. executable `cloudflared` already available on `PATH`;
4. failure with an actionable diagnostic.

Runtime GitHub download is removed from the default path. A clean `npx agentroam@preview` install obtains both npm packages from `https://registry.npmjs.org` and therefore does not depend on Node `fetch`, macOS system proxy discovery, or GitHub reachability.

When the platform package is selected, AgentRoam:

1. resolves its exported manifest and archive path through Node package resolution;
2. validates archive size and SHA-256;
3. extracts to a temporary directory under the AgentRoam data directory;
4. validates that exactly one expected `cloudflared` executable was produced;
5. sets mode `0755`;
6. atomically replaces `~/.agentroam/bin/cloudflared` and its source marker.

A checksum or extraction failure never executes the artifact. AgentRoam may continue to a trusted executable already on `PATH`; otherwise Cloudflare fails and automatic mode proceeds to Pinggy.

## 5. Relay Modes

The CLI accepts:

```text
--relay auto          default: Cloudflare -> Pinggy -> LAN
--relay cloudflare    Cloudflare only, then LAN fallback
--relay pinggy        Pinggy only, then LAN fallback
--relay custom        existing custom command, then LAN fallback
--local-only          skip public providers and use LAN directly
```

Existing commands remain compatible. The default changes from `cloudflare` to `auto`.

## 6. Provider Readiness

Parsing a public URL is not sufficient. Every public provider must pass a bounded readiness probe against:

```text
GET <public-url>/api/web-auth/status
```

The probe succeeds only on an HTTP 200 response with the expected JSON shape. It retries transient `404`, `502`, `503`, and Cloudflare `530` responses within a provider-specific deadline.

The CLI prints and encodes a public URL only after readiness succeeds. If readiness fails, it closes that provider before starting the next provider. This prevents QR codes that point to allocated but unusable tunnels.

## 7. Pinggy Provider

Pinggy is the account-free fallback because its official free tunnel uses the system OpenSSH client over outbound port 443:

```bash
ssh -p 443 -R0:localhost:<port> free.pinggy.io
```

The provider:

- requires an executable `ssh` on `PATH`;
- uses batch-safe options and `ServerAliveInterval=30`;
- stores the accepted host key in the AgentRoam data directory instead of disabling host-key checking;
- parses only an HTTPS `*.pinggy-free.link` URL;
- forwards stdout and stderr through redacted diagnostics;
- terminates the entire SSH process group during fallback or shutdown.

Free Pinggy limitations are visible in the terminal:

- tunnel lifetime is limited to 60 minutes;
- the public hostname changes between sessions;
- a phone browser sees a one-time Pinggy security confirmation before AgentRoam pairing;
- Pinggy terminates public TLS and is therefore part of the same trusted relay boundary as Cloudflare.

The real E2E gate must confirm that the one-time browser screen preserves the full AgentRoam path and pairing query string and that WebSocket upgrade works after confirmation. If either fails, Pinggy is not enabled as the automatic fallback.

## 8. Startup and Error Flow

```text
validate Node/platform/native modules
  -> create five-minute pairing secret
  -> start local Web/PTY gateway with the pairing hash and expiry
  -> choose RFC1918 LAN URL
  -> in auto mode:
       resolve bundled cloudflared
       start Cloudflare and wait for public readiness
       on failure: stop Cloudflare and start Pinggy
       wait for Pinggy public readiness
       on failure: stop Pinggy and select LAN URL
  -> print one final URL and QR code
  -> supervise local gateway and selected provider
```

Diagnostics distinguish:

- platform package missing;
- checksum or extraction failure;
- cloudflared URL allocation failure;
- Cloudflare public readiness failure, including HTTP 530;
- SSH unavailable or host-key failure;
- Pinggy URL or readiness failure;
- final LAN-only fallback.

Pairing tokens remain single-use and expire after five minutes. Provider logs and CLI errors redact pairing values.

## 9. Testing

### Unit tests

- platform package manifest validation;
- archive size and SHA-256 validation;
- safe extraction and executable permission repair;
- resolver ordering and missing optional dependency behavior;
- `auto`, `cloudflare`, `pinggy`, `custom`, and `local-only` argument parsing;
- Cloudflare and Pinggy URL parsing;
- provider cleanup and process-group termination;
- readiness retry, timeout, and fallback ordering;
- pairing-token redaction.

### Package tests

- audit both tarballs independently;
- reject unexpected files and mismatched package identity;
- install both packages from tarballs in a clean Node 22 directory with GitHub unavailable;
- run `doctor`, local health, LAN pairing URL, better-sqlite3, and real zsh PTY smoke;
- prove the main package extracts and runs the cloudflared artifact from the optional dependency.

### Real network tests

- Cloudflare Quick Tunnel: public health, pairing setup, Secure Cookie, nonce, and WSS hello;
- Pinggy free tunnel: one-time browser confirmation, preserved pairing URL, public health, pairing setup, Secure Cookie, nonce, and WSS hello;
- forced Cloudflare failure: automatic Pinggy selection;
- forced Cloudflare and Pinggy failure: RFC1918 LAN QR selection;
- Ctrl+C: no remaining gateway, cloudflared, or SSH listener/process.

## 10. Publication

Publish the platform package first, then the main package:

```text
agentroam-cloudflared-darwin-arm64@0.2.0-preview.3  tag=preview
agentroam@0.2.0-preview.3                           tag=preview
```

Both publishes use the official npm registry and independent WebAuthn authorization windows. After automated npm validation completes, verify exact versions, OS/CPU metadata, integrity, dist-tags, and an empty-cache `npx agentroam@preview` installation.

`latest` remains `0.2.0-preview.1`. No Git commit or push is part of this release task.

## 11. Acceptance Criteria

- A clean macOS arm64/Node 22 machine installs from npm without contacting GitHub at runtime.
- Cloudflare receives a verified packaged cloudflared 2026.8.2 executable.
- The QR code is printed only for a route that passed readiness.
- Default startup selects Cloudflare, then Pinggy, then LAN in order.
- A phone on another network can pair and establish WSS through at least one public provider without a phone VPN.
- A phone on the same LAN can still connect when both public providers fail.
- Both npm tarballs remain independently auditable and below 30 MB.
- `preview` advances to `0.2.0-preview.3`; `latest` remains unchanged.
- No unrelated worktree changes are committed, reverted, or pushed.
