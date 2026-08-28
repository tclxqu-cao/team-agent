# AgentRoam Public Readiness System Proxy Design

## Goal

Allow AgentRoam's public tunnel readiness request to use an explicitly configured proxy or the active macOS system proxy, without changing cloudflared's QUIC connection, local runtime traffic, or the Cloudflare-to-Pinggy fallback contract.

## Current Problem

`agentroam@0.2.0-preview.3` bundles cloudflared, so startup no longer depends on downloading a binary from GitHub. A current failure occurs later:

- cloudflared creates a Quick Tunnel and registers a QUIC connection successfully;
- cloudflared connectivity checks pass DNS, UDP, TCP, and Cloudflare API access;
- `waitForPublicReadiness` uses Node's global `fetch` to request the generated `https://*.trycloudflare.com/api/web-auth/status` endpoint;
- Node does not use the active macOS system proxy automatically, so the generated hostname fails local DNS resolution;
- the relay orchestrator treats the readiness failure as a failed provider, terminates cloudflared, and falls back to Pinggy.

On the affected machine, direct Node 22 access to the stopped Quick Tunnel hostname returned `ENOTFOUND`. The same request with Clash `127.0.0.1:7897` explicitly configured reached Cloudflare and returned the expected offline 530 response. The packaged binary and Cloudflare data-plane connection are not the failure.

## Approaches

### Endpoint-Specific Proxy Agent

Resolve a proxy only for the public readiness endpoint and use `undici.ProxyAgent` for that request. Environment proxy variables take precedence; macOS system settings are a fallback. This keeps proxy scope narrow and preserves the existing public health gate.

This is the selected approach.

### Process-Wide Node Proxy Mode

Respawn AgentRoam with `NODE_OPTIONS=--use-env-proxy` after translating macOS proxy settings into environment variables. This relies on process startup behavior, affects every Node request, and complicates signal/process ownership.

### Trust cloudflared Registration

Treat the emitted public URL or `Registered tunnel connection` log as sufficient readiness. This would avoid the failing fetch but can publish a QR code before the public route works, recreating the false-success behavior that preview.3 intentionally removed.

## Design

### Proxy Resolution

Add a focused proxy-settings module under `packages/cli/src/tunnel/`.

For a public endpoint URL:

1. Respect `NO_PROXY`/`no_proxy`; a matching host bypasses every proxy source.
2. Prefer `HTTPS_PROXY`/`https_proxy` for HTTPS and `HTTP_PROXY`/`http_proxy` for HTTP.
3. For HTTPS, fall back to the configured HTTP proxy when no HTTPS proxy exists, matching common proxy-agent behavior.
4. When no applicable environment proxy exists and the platform is macOS, execute `/usr/sbin/scutil --proxy` with a short timeout.
5. Parse enabled HTTPS or HTTP proxy host/port pairs and return a normalized proxy URL.
6. On unsupported platforms, disabled proxy settings, malformed output, or command failure, return no proxy and retain direct fetch behavior.

The resolver must not log proxy URLs or credentials. The macOS parser accepts host and numeric port only and rejects malformed values.

### Readiness Fetch

Keep the existing injectable `fetchImpl` test seam. When a custom fetch is provided, use it unchanged and do not inspect system proxy settings.

For the default path:

- resolve the proxy once per `waitForPublicReadiness` invocation;
- use the existing global fetch when no proxy applies;
- otherwise create one `undici.ProxyAgent`, call `undici.fetch` with that dispatcher for all retries, and close the dispatcher in `finally`;
- preserve the current 30-second timeout, 750ms retry interval, accepted transient statuses, JSON contract, and abort behavior.

Only the public readiness URL uses the dispatcher. Local `/api/web-auth/status`, PTY traffic, WebSocket traffic, cloudflared, and Pinggy processes retain their existing networking behavior.

### Dependency Boundary

Declare `undici` as a direct runtime dependency of `packages/cli`. The CLI already targets Node 22, and the repository currently resolves undici 6.25.0 transitively; making it direct ensures the published package installs the dispatcher implementation it imports.

## Error Handling

- A proxy discovery failure is non-fatal and falls back to direct readiness.
- A configured but unreachable proxy produces the existing retry and final readiness error rather than silently bypassing the user's proxy.
- Abort closes the active dispatcher and retains the existing `public tunnel readiness aborted` result.
- Proxy credentials, if supplied through environment variables, never appear in logs or error messages.

## Testing

Add pure tests for:

- environment proxy precedence for HTTP and HTTPS URLs;
- lowercase environment variable support;
- `NO_PROXY` exact host, suffix, wildcard, and optional port behavior;
- macOS HTTPS proxy parsing and HTTP fallback;
- disabled, malformed, non-macOS, and command-failure fallback to direct mode.

Extend readiness tests to prove:

- injected fetch behavior remains unchanged;
- the default proxy-aware fetch uses one dispatcher across retries;
- the dispatcher closes after success, timeout, fatal payload, and abort;
- no dispatcher is created when proxy resolution returns no proxy.

Run the focused CLI tunnel tests, CLI TypeScript build, full CLI test suite, and package audit. Perform a real startup with Clash system proxy enabled and TUN disabled; Cloudflare should remain selected after readiness instead of being terminated in favor of Pinggy.

## Non-Goals

- Proxying cloudflared QUIC or HTTP/2 connections.
- Enabling or disabling Clash TUN.
- Removing Pinggy or LAN fallback.
- Accepting a public URL without the expected WebAuth status JSON.
- Adding Windows or Linux desktop proxy auto-discovery in this change.
