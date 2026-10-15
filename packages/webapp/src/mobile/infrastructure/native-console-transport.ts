import type { NativePairingClient } from "./native-pairing";

/** Route shell API calls to the selected server; bundled scripts and frames stay local. */
export function createNativeConsoleFetch(origin: string, localPageUrl: string, client: Pick<NativePairingClient, "fetch">, fallback: typeof fetch): typeof fetch {
  const local = new URL(localPageUrl);
  return (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, local);
    // Custom schemes have an opaque origin in URL implementations. Compare the
    // actual scheme and host instead of treating every opaque origin as local.
    const bundled = url.protocol === local.protocol && url.host === local.host;
    if (url.pathname.startsWith("/api/") && (bundled || url.origin === origin)) {
      const remote = new URL(url.pathname + url.search, origin);
      return client.fetch(input instanceof Request ? new Request(remote, input) : remote, init);
    }
    return fallback(input, init);
  };
}

export function nativeWorkspaceFrameUrl(path: string, pageUrl: string): string {
  const view = new URL(path, "https://agentroam.local");
  if (view.pathname !== "/app/") throw new Error("Invalid workspace frame path");
  const local = new URL(pageUrl);
  local.search = view.search;
  local.searchParams.set("workspace", "1");
  local.hash = "";
  return local.href;
}
