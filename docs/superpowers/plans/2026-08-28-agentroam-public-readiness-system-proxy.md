# AgentRoam Public Readiness System Proxy Implementation Plan

> **For the main agent:** Implement this plan directly in the current session. Do not dispatch implementation or code-review subagents. After all development tasks are complete, run the affected unit tests and fix any failures before reporting completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AgentRoam's public tunnel health check automatically use environment proxy settings or the active macOS system proxy while leaving cloudflared and local traffic unchanged.

**Architecture:** A new proxy-settings module resolves one proxy URL for the public readiness endpoint with environment and `NO_PROXY` precedence, then falls back to parsing `/usr/sbin/scutil --proxy` on macOS. `waitForPublicReadiness` creates an endpoint-scoped `undici.ProxyAgent` only when a proxy applies and closes it after the retry loop.

**Tech Stack:** TypeScript, Node.js 22, undici 6.25, Vitest 2, macOS `scutil`

## Global Constraints

- Proxy only the public readiness endpoint; do not proxy cloudflared, Pinggy, PTY, WebSocket, or local runtime traffic.
- Preserve the 30-second timeout, 750ms interval, transient status list, WebAuth JSON contract, and relay fallback behavior.
- Environment proxy variables take precedence over macOS system settings.
- Respect `NO_PROXY`/`no_proxy` before every proxy source.
- Never log proxy URLs or credentials.
- Preserve unrelated uncommitted CLI and lockfile changes.

---

### Task 1: Public Endpoint Proxy Resolution

**Files:**
- Create: `packages/cli/src/tunnel/proxy-settings.ts`
- Unit tests: `packages/cli/src/tunnel/proxy-settings.test.ts`

**Interfaces:**
- Consumes: target `URL`, optional `NodeJS.ProcessEnv`, platform, and injectable macOS proxy reader.
- Produces: `resolveProxyForUrl(target: URL, options?: ProxyResolverOptions): Promise<string | null>` and `parseMacSystemProxy(output: string): SystemProxySettings`.

- [x] **Step 1: Implement environment and `NO_PROXY` resolution**

Resolve lowercase and uppercase environment variables, select a protocol-appropriate proxy, normalize an omitted scheme to `http://`, and return `null` when `NO_PROXY` matches wildcard, exact host, domain suffix, or host plus port.

```ts
export interface ProxyResolverOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  readMacSystemProxy?: () => Promise<string>;
}

export async function resolveProxyForUrl(
  target: URL,
  options: ProxyResolverOptions = {},
): Promise<string | null> {
  const env = options.env ?? process.env;
  if (matchesNoProxy(target, env.no_proxy ?? env.NO_PROXY)) return null;
  const environmentProxy = selectEnvironmentProxy(target.protocol, env);
  if (environmentProxy) return normalizeProxyUrl(environmentProxy);
  // macOS fallback is implemented in Step 2.
  return null;
}
```

- [x] **Step 2: Implement macOS system proxy discovery**

Use `execFile("/usr/sbin/scutil", ["--proxy"], ...)` with a 2-second timeout. Parse enabled HTTPS and HTTP host/port settings, prefer HTTPS for HTTPS targets, and fall back to HTTP. Return `null` for command failure, invalid ports, disabled settings, or non-macOS platforms.

```ts
export interface SystemProxySettings {
  httpProxy: string | null;
  httpsProxy: string | null;
}

export function parseMacSystemProxy(output: string): SystemProxySettings {
  const values = parseScutilValues(output);
  return {
    httpProxy: buildMacProxy(values, "HTTP"),
    httpsProxy: buildMacProxy(values, "HTTPS"),
  };
}

async function readMacSystemProxy(): Promise<string> {
  const { stdout } = await execFileAsync("/usr/sbin/scutil", ["--proxy"], {
    encoding: "utf8",
    timeout: 2_000,
  });
  return stdout;
}
```

- [x] **Step 3: Add focused resolver tests**

Cover environment precedence, lowercase variables, `NO_PROXY` forms, HTTPS-to-HTTP fallback, valid macOS output, disabled output, malformed values, command failure, and non-macOS direct mode.

```ts
it("falls back to the enabled macOS HTTPS proxy", async () => {
  const proxy = await resolveProxyForUrl(new URL("https://example.test/status"), {
    env: {},
    platform: "darwin",
    readMacSystemProxy: async () => "HTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 7897",
  });
  expect(proxy).toBe("http://127.0.0.1:7897/");
});
```

### Task 2: Proxy-Aware Public Readiness

**Files:**
- Modify: `packages/cli/src/tunnel/public-readiness.ts`
- Modify: `packages/cli/src/tunnel/public-readiness.test.ts`

**Interfaces:**
- Consumes: `resolveProxyForUrl(endpoint)` from Task 1 and `undici.ProxyAgent`.
- Produces: unchanged `waitForPublicReadiness(publicUrl, options): Promise<void>` with optional `proxyResolver` and `proxyFetchFactory` test seams.

- [x] **Step 1: Create the default proxy fetch handle**

Create one `ProxyAgent` for the resolved proxy URL, adapt `undici.fetch` to the existing Response contract, and return `{ fetch, close }` without exposing the proxy URL in errors.

```ts
type ReadinessFetch = (input: URL, init: RequestInit) => Promise<Response>;

interface ProxyFetchHandle {
  fetch: ReadinessFetch;
  close: () => Promise<void>;
}

function createProxyFetch(proxyUrl: string): ProxyFetchHandle {
  const dispatcher = new ProxyAgent(proxyUrl);
  return {
    fetch: async (input, init) =>
      await undiciFetch(input, { ...init, dispatcher } as UndiciRequestInit) as unknown as Response,
    close: async () => { await dispatcher.close(); },
  };
}
```

- [x] **Step 2: Integrate proxy resolution into readiness**

When `fetchImpl` is supplied, preserve existing behavior and skip discovery. Otherwise resolve once, use global fetch for direct mode or the proxy fetch handle for proxy mode, run the existing retry loop unchanged, and close the handle in `finally`.

```ts
const proxyResolver = options.proxyResolver ?? resolveProxyForUrl;
const proxyFetchFactory = options.proxyFetchFactory ?? createProxyFetch;
let proxyFetch: ProxyFetchHandle | null = null;
let fetchImpl = options.fetchImpl;

if (!fetchImpl) {
  const proxyUrl = await proxyResolver(endpoint).catch(() => null);
  if (proxyUrl) proxyFetch = proxyFetchFactory(proxyUrl);
  fetchImpl = proxyFetch?.fetch ?? fetch;
}

try {
  await runReadinessLoop(endpoint, fetchImpl, options);
} finally {
  await proxyFetch?.close();
}
```

- [x] **Step 3: Extend lifecycle tests**

Verify one proxy handle is reused across transient retries, it closes after success/fatal response/timeout/abort, direct mode does not create a proxy handle, and injected fetch does not invoke the resolver.

```ts
it("uses one proxy handle across retries and closes it", async () => {
  const close = vi.fn(async () => {});
  const proxiedFetch = vi.fn()
    .mockResolvedValueOnce(new Response("unavailable", { status: 530 }))
    .mockResolvedValueOnce(Response.json({ authenticated: false, needsSetup: true }));

  await waitForPublicReadiness("https://example.test", {
    intervalMs: 1,
    timeoutMs: 100,
    proxyResolver: async () => "http://127.0.0.1:7897/",
    proxyFetchFactory: () => ({ fetch: proxiedFetch, close }),
  });

  expect(proxiedFetch).toHaveBeenCalledTimes(2);
  expect(close).toHaveBeenCalledOnce();
});
```

### Task 2A: Avoid Pre-Registration Readiness Requests

**Files:**
- Modify: `packages/cli/src/tunnel/cloudflare-provider.ts`
- Unit tests: `packages/cli/src/tunnel/cloudflare-provider.test.ts`

**Interfaces:**
- Consumes: cloudflared stdout/stderr containing the Quick Tunnel URL and `Registered tunnel connection` event.
- Produces: `waitForConnectedUrl(child, log, timeoutMs): Promise<string>` so readiness starts only after URL allocation and data-plane registration both complete.

- [x] **Step 1: Gate provider startup on URL and connection registration**

Store the first Quick Tunnel URL independently from the rolling log buffer, recognize the registration event in either output stream, and resolve only after both states are present. Preserve the existing 30-second provider startup timeout and child-process cleanup behavior.

```ts
if (match) publicUrl = match[0];
if (/Registered tunnel connection/i.test(buffer)) connected = true;
if (publicUrl && connected) finish(undefined, publicUrl);
```

- [x] **Step 2: Add ordering tests**

Verify that URL allocation alone does not resolve startup and that both URL-first and registration-first output orders resolve to the expected public URL.

```ts
child.stderr.write("https://ready.trycloudflare.com\n");
expect(resolved).toBe(false);
child.stderr.write("Registered tunnel connection\n");
await expect(ready).resolves.toBe("https://ready.trycloudflare.com");
```

### Task 3: Published CLI Dependency Boundary

**Files:**
- Modify: `packages/cli/package.json`
- Modify: `bun.lock`

**Interfaces:**
- Consumes: undici version already resolved by the workspace.
- Produces: a direct `undici` runtime dependency available after installing the published `agentroam` package.

- [x] **Step 1: Add undici as a direct dependency**

Add `"undici": "^6.25.0"` next to `qrcode-terminal` and update only the corresponding workspace dependency metadata in `bun.lock` through the repository package manager.

```json
{
  "dependencies": {
    "qrcode-terminal": "^0.12.0",
    "undici": "^6.25.0"
  }
}
```

- [x] **Step 2: Confirm package contents and dependency metadata**

Build the CLI, run an ignored-scripts pack dry run, and verify the generated package metadata contains the direct dependency without adding source, secrets, or unrelated files.

## Final Unit Test Verification

- [x] **Main agent: run affected unit tests after development is complete**

Run: `bunx vitest run packages/cli/src/tunnel/proxy-settings.test.ts packages/cli/src/tunnel/public-readiness.test.ts packages/cli/src/tunnel/relay-orchestrator.test.ts`
Expected: PASS

Run: `bun run --cwd packages/cli build`
Expected: PASS

Run: `bun run --cwd packages/cli test`
Expected: PASS

Run: `npm pack ./packages/cli --dry-run --ignore-scripts --json`
Expected: PASS and package metadata retains only the declared CLI files.

Perform a real `agentroam` startup with Clash system proxy enabled, TUN disabled, and no proxy environment variables. Expected: Cloudflare Quick Tunnel registers, public readiness succeeds through the detected system proxy, and the orchestrator keeps Cloudflare instead of terminating it for Pinggy fallback.
