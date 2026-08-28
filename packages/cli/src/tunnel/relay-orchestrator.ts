import type { CliOptions, RelayMode } from "../args.js";
import type { PlatformTarget } from "../platform.js";
import { ensureCloudflared } from "../cloudflared/installer.js";
import { CloudflareTunnelProvider } from "./cloudflare-provider.js";
import { CustomCommandTunnelProvider } from "./custom-command-provider.js";
import { PinggyTunnelProvider } from "./pinggy-provider.js";
import { waitForPublicReadiness } from "./public-readiness.js";
import type { TunnelHandle, TunnelProvider } from "./tunnel-provider.js";

type PublicProviderName = Exclude<RelayMode, "auto">;

export interface RelaySelection {
  tunnel: TunnelHandle | null;
  publicUrl: string;
  provider: PublicProviderName | "lan";
  failures: Array<{ provider: PublicProviderName; message: string }>;
}

interface RelayOrchestratorOptions {
  cli: CliOptions;
  target: PlatformTarget;
  localUrl: string;
  lanUrl: string;
  port: number;
  signal: AbortSignal;
  log: (line: string) => void;
  onAttempt?: (provider: PublicProviderName) => void;
  onFailure?: (provider: PublicProviderName, message: string) => void;
  providerFactories?: Partial<Record<PublicProviderName, () => Promise<TunnelProvider>>>;
  readiness?: typeof waitForPublicReadiness;
}

export async function selectRelay(options: RelayOrchestratorOptions): Promise<RelaySelection> {
  if (options.cli.localOnly) return { tunnel: null, publicUrl: options.lanUrl, provider: "lan", failures: [] };

  const providers: PublicProviderName[] =
    options.cli.relay === "auto" ? ["cloudflare", "pinggy"] : [options.cli.relay];
  const failures: RelaySelection["failures"] = [];
  const readiness = options.readiness ?? waitForPublicReadiness;

  for (const providerName of providers) {
    options.onAttempt?.(providerName);
    let tunnel: TunnelHandle | null = null;
    try {
      const provider = await createProvider(providerName, options);
      tunnel = await provider.start({ localUrl: options.localUrl, signal: options.signal, log: options.log });
      await readiness(tunnel.publicUrl, { signal: options.signal });
      return { tunnel, publicUrl: tunnel.publicUrl, provider: providerName, failures };
    } catch (error) {
      await tunnel?.close().catch(() => {});
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ provider: providerName, message });
      options.onFailure?.(providerName, message);
      if (options.signal.aborted) break;
    }
  }

  return { tunnel: null, publicUrl: options.lanUrl, provider: "lan", failures };
}

async function createProvider(name: PublicProviderName, options: RelayOrchestratorOptions): Promise<TunnelProvider> {
  const override = options.providerFactories?.[name];
  if (override) return await override();
  if (name === "cloudflare") {
    const executable = await ensureCloudflared(options.target, options.cli.dataDir);
    return new CloudflareTunnelProvider(executable);
  }
  if (name === "pinggy") return new PinggyTunnelProvider(options.port, options.cli.dataDir);
  return new CustomCommandTunnelProvider(options.cli.tunnelCommand!, options.port);
}
