import { fetch as undiciFetch, ProxyAgent } from "undici";
import type { RequestInit as UndiciRequestInit } from "undici";
import { resolveProxyForUrl } from "./proxy-settings.js";
import { AGENTROAM_VERSION } from "../platform-packages.js";

type ReadinessFetch = (input: URL, init: RequestInit) => Promise<Response>;

interface ProxyFetchHandle {
  fetch: ReadinessFetch;
  close: () => Promise<void>;
}

export interface ReadinessOptions {
  timeoutMs?: number;
  intervalMs?: number;
  fetchImpl?: ReadinessFetch;
  signal?: AbortSignal;
  proxyResolver?: (endpoint: URL) => Promise<string | null>;
  proxyFetchFactory?: (proxyUrl: string) => ProxyFetchHandle;
}

export async function waitForPublicReadiness(
  publicUrl: string,
  options: ReadinessOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 750;
  const endpoint = new URL("/api/web-auth/status", `${publicUrl.replace(/\/$/, "")}/`);
  let proxyFetch: ProxyFetchHandle | null = null;
  let fetchImpl = options.fetchImpl;

  if (!fetchImpl) {
    const proxyResolver = options.proxyResolver ?? resolveProxyForUrl;
    const proxyUrl = await proxyResolver(endpoint).catch(() => null);
    if (proxyUrl) proxyFetch = (options.proxyFetchFactory ?? createProxyFetch)(proxyUrl);
    fetchImpl = proxyFetch?.fetch ?? fetch;
  }

  try {
    const deadline = Date.now() + timeoutMs;
    let lastFailure = "no response";

    while (Date.now() <= deadline) {
      if (options.signal?.aborted) throw new Error("public tunnel readiness aborted");
      try {
        const response = await fetchImpl(endpoint, {
          cache: "no-store",
          headers: { "user-agent": `agentroam-readiness/${AGENTROAM_VERSION}` },
          signal: options.signal,
        });
        if (response.ok) {
          let body: Record<string, unknown>;
          try {
            body = (await response.json()) as Record<string, unknown>;
          } catch {
            throw new FatalReadinessError("HTTP 200 with invalid auth status JSON");
          }
          if (typeof body.authenticated === "boolean" && typeof body.needsSetup === "boolean") return;
          throw new FatalReadinessError("HTTP 200 with invalid auth status JSON");
        } else {
          lastFailure = `HTTP ${response.status}`;
          if (![404, 502, 503, 530].includes(response.status)) throw new FatalReadinessError(lastFailure);
        }
      } catch (error) {
        if (options.signal?.aborted) throw new Error("public tunnel readiness aborted");
        if (error instanceof FatalReadinessError) throw new Error(`public tunnel not ready: ${error.message}`);
        lastFailure = error instanceof Error ? error.message : String(error);
      }
      if (Date.now() + intervalMs > deadline) break;
      await delay(intervalMs, options.signal);
    }

    throw new Error(`public tunnel not ready: ${lastFailure}`);
  } finally {
    await proxyFetch?.close().catch(() => {});
  }
}

class FatalReadinessError extends Error {}

function createProxyFetch(proxyUrl: string): ProxyFetchHandle {
  const dispatcher = new ProxyAgent(proxyUrl);
  return {
    fetch: async (input, init) =>
      (await undiciFetch(input, { ...init, dispatcher } as UndiciRequestInit)) as unknown as Response,
    close: async () => {
      await dispatcher.close();
    },
  };
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(resolvePromise, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("public tunnel readiness aborted"));
      },
      { once: true },
    );
  });
}
