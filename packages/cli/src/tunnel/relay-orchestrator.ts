import type { CliOptions, RelayMode } from "../args.js";
import type { PlatformTarget } from "../platform.js";
import { ensureCloudflared } from "../cloudflared/installer.js";
import { CloudflareTunnelProvider } from "./cloudflare-provider.js";
import { CustomCommandTunnelProvider } from "./custom-command-provider.js";
import { PinggyTunnelProvider } from "./pinggy-provider.js";
import { waitForPublicReadiness } from "./public-readiness.js";
import type { TunnelHandle, TunnelProvider } from "./tunnel-provider.js";
import { withAbortSignal } from "../abort.js";

export const RELAY_START_TIMEOUT_MS = 30_000;

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
  timeoutMs?: number;
  providerFactories?: Partial<Record<PublicProviderName, () => Promise<TunnelProvider>>>;
  readiness?: typeof waitForPublicReadiness;
}

export async function selectRelay(options: RelayOrchestratorOptions): Promise<RelaySelection> {
  options.signal.throwIfAborted();
  if (options.cli.localOnly) return { tunnel: null, publicUrl: options.lanUrl, provider: "lan", failures: [] };

  const providers: PublicProviderName[] =
    options.cli.relay === "auto" ? ["cloudflare"] : [options.cli.relay];
  const failures: RelaySelection["failures"] = [];
  const readiness = options.readiness ?? waitForPublicReadiness;

  for (const providerName of providers) {
    options.onAttempt?.(providerName);
    const attempt: { tunnel: TunnelHandle | null } = { tunnel: null };
    const deadline = new AbortController();
    const timeoutMs = options.timeoutMs ?? RELAY_START_TIMEOUT_MS;
    const timer = setTimeout(() => deadline.abort(new Error(`relay connection timed out after ${timeoutMs}ms`)), timeoutMs);
    const signal = AbortSignal.any([options.signal, deadline.signal]);
    try {
      return await withAbortSignal(async () => {
        const provider = await createProvider(providerName, options);
        signal.throwIfAborted();
        const handle = await provider.start({ localUrl: options.localUrl, signal, log: options.log });
        if (signal.aborted) {
          void handle.close().catch(() => {});
          signal.throwIfAborted();
        }
        attempt.tunnel = handle;
        await readiness(handle.publicUrl, { signal });
        signal.throwIfAborted();
        return { tunnel: handle, publicUrl: handle.publicUrl, provider: providerName, failures };
      }, signal);
    } catch (error) {
      deadline.abort(error);
      if (attempt.tunnel) await withAbortSignal(() => attempt.tunnel!.close(), AbortSignal.timeout(3_000)).catch(() => {});
      options.signal.throwIfAborted();
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ provider: providerName, message });
      options.onFailure?.(providerName, message);
    } finally {
      clearTimeout(timer);
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
