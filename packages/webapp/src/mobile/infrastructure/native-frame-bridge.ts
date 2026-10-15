/** Bundled frames use the top-level transport, where Capacitor and secure
 * storage live. Credentials never enter frame URLs or ordinary storage. */
export interface NativeFrameBridge { origin: string; fetch: typeof fetch }
declare global { interface Window { __agentroamNativeFrame?: NativeFrameBridge } }

export function nativeFrameBridge(): NativeFrameBridge | null {
  if (window.parent === window || new URLSearchParams(location.search).get("workspace") !== "1") return null;
  try {
    const parent = new URL(window.parent.location.href);
    if (parent.protocol !== location.protocol || parent.host !== location.host) return null;
    return window.parent.__agentroamNativeFrame ?? null;
  } catch { return null; }
}

/** Normalize requests in the child realm before crossing the Window boundary. */
export function nativeFrameFetch(bridge: NativeFrameBridge): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    return bridge.fetch(request.url, {
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
      signal: request.signal,
      cache: request.cache,
    });
  };
}
