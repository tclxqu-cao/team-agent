import { fetch as undiciFetch, ProxyAgent } from "undici";
import type { RequestInit as UndiciRequestInit } from "undici";
import { resolveProxyForUrl } from "./proxy-settings.js";
import { AGENTROAM_VERSION } from "../platform-packages.js";
import { withAbortSignal } from "../abort.js";

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
  const deadline = Date.now() + timeoutMs;
  const controller = new AbortController();
  let lastFailure = "no response";
  const timer = setTimeout(() => {
    const detail = lastFailure === "no response" ? "request timed out" : `${lastFailure} (request timed out)`;
    controller.abort(new Error(`public tunnel not ready: ${detail}`));
  }, timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const connection: { proxy: ProxyFetchHandle | null } = { proxy: null };
  let fetchImpl = options.fetchImpl;

  try {
    await withAbortSignal(async () => {
      if (!fetchImpl) {
        const proxyResolver = options.proxyResolver ?? resolveProxyForUrl;
        const proxyUrl = await proxyResolver(endpoint).catch(() => null);
        signal.throwIfAborted();
        if (proxyUrl) connection.proxy = (options.proxyFetchFactory ?? createProxyFetch)(proxyUrl);
        fetchImpl = connection.proxy?.fetch ?? fetch;
      }
      while (Date.now() <= deadline) {
        signal.throwIfAborted();
        try {
          const response = await fetchImpl(endpoint, {
            cache: "no-store",
            headers: { "user-agent": `agentroam-readiness/${AGENTROAM_VERSION}` },
            signal,
          });
          if (response.ok) {
            let body: Record<string, unknown>;
            try {
              body = (await response.json()) as Record<string, unknown>;
            } catch {
              throw new FatalReadinessError("HTTP 200 with invalid auth status JSON");
            }
            signal.throwIfAborted();
            if (typeof body.authenticated === "boolean" && typeof body.needsSetup === "boolean") return;
            throw new FatalReadinessError("HTTP 200 with invalid auth status JSON");
          } else {
            lastFailure = `HTTP ${response.status}`;
            void response.body?.cancel().catch(() => {});
            if (![404, 502, 503, 530].includes(response.status)) throw new FatalReadinessError(lastFailure);
          }
        } catch (error) {
          if (options.signal?.aborted) throw new Error("public tunnel readiness aborted");
          signal.throwIfAborted();
          if (error instanceof FatalReadinessError) throw new Error(`public tunnel not ready: ${error.message}`);
          lastFailure = error instanceof Error ? error.message : String(error);
        }
        if (Date.now() + intervalMs > deadline) break;
        await delay(intervalMs, signal);
      }

      throw new Error(`public tunnel not ready: ${lastFailure}`);
    }, signal);
  } catch (error) {
    if (options.signal?.aborted) throw new Error("public tunnel readiness aborted");
    throw error;
  } finally {
    clearTimeout(timer);
    if (connection.proxy) await withAbortSignal(() => connection.proxy!.close(), AbortSignal.timeout(3_000)).catch(() => {});
  }
}

class FatalReadinessError extends Error {}

function createProxyFetch(proxyUrl: string): ProxyFetchHandle {
  const dispatcher = new ProxyAgent(proxyUrl);
  return {
    fetch: async (input, init) =>
      (await undiciFetch(input, { ...init, dispatcher } as UndiciRequestInit)) as unknown as Response,
    close: async () => {
      await dispatcher.destroy();
    },
  };
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolvePromise();
    }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
