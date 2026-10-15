import { StrictMode } from "react";
import type { Root } from "react-dom/client";
import { configureNativeConsole } from "../../../../server/app/web/console-environment";
import WorkspaceBoot from "../../../../server/app/web/WorkspaceBoot";
import { readComputers, rememberComputer, saveComputers } from "../../../../server/public/pwa/computer-directory.js";
import { LocalEndpointStorage } from "../infrastructure/local-endpoint-storage";
import { NativeCredentialStorage, NativePairingClient, scanPairingQr } from "../infrastructure/native-pairing";
import { createNativeConsoleFetch, nativeWorkspaceFrameUrl } from "../infrastructure/native-console-transport";
import { ServerEndpoint } from "../domain/server-endpoint";

export function rememberNativeEndpoint(endpoint: ServerEndpoint): void {
  saveComputers(rememberComputer(endpoint.url, undefined, readComputers()));
  new LocalEndpointStorage().save(endpoint);
}

export async function mountNativeConsole(root: Root, endpoint: ServerEndpoint, pairing: NativePairingClient, fallback: typeof fetch): Promise<void> {
  root.render(<WorkspaceBoot />);
  window.__agentroamNativeFrame = { origin: endpoint.url, fetch: pairing.fetch };
  globalThis.fetch = createNativeConsoleFetch(endpoint.url, location.href, pairing, fallback);
  const pair = async (raw: string) => {
    const next = await pairing.pair(raw);
    rememberNativeEndpoint(next);
    location.reload();
  };
  configureNativeConsole({
    origin: endpoint.url,
    frameUrl: path => nativeWorkspaceFrameUrl(path, location.href),
    pair,
    scan: async () => { const raw = await scanPairingQr(); if (raw) await pair(raw); },
    switchComputer: async origin => {
      const next = ServerEndpoint.parse(origin);
      if (!next) throw new Error("电脑地址无效，请重新扫码。");
      // Validate the saved identity before switching; never borrow another origin's token.
      const client = new NativePairingClient(new NativeCredentialStorage(), fallback, () => {});
      await client.resume(next);
      const response = await client.fetch(next.api("/api/web-auth/status"), { signal: AbortSignal.timeout(5000) });
      const status = response.ok ? await response.json() : null;
      if (!status?.authenticated || status.locked) throw new Error("这台电脑需要重新授权，请点击扫码添加电脑。");
      rememberNativeEndpoint(next);
      location.reload();
    },
  });
  const { default: Console } = await import("../../../../server/app/web/page");
  root.render(<StrictMode><Console /></StrictMode>);
}
