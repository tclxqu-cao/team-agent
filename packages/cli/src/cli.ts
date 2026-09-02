import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./args.js";
import { ensureCloudflared } from "./cloudflared/installer.js";
import { repairNativeRuntimePermissions } from "./native-runtime.js";
import { findLanUrl } from "./network.js";
import { createPairingSecret } from "./pairing.js";
import { detectPlatform, type PlatformTarget } from "./platform.js";
import { renderQr } from "./qr.js";
import { RuntimeManager, type RuntimeHandle } from "./runtime-manager.js";
import { selectRelay, type RelaySelection } from "./tunnel/relay-orchestrator.js";

const VERSION = "0.2.0-preview.6";

export async function main(argv: string[]): Promise<void> {
  const options = parseArgs(argv);
  const target = detectPlatform();

  if (options.command === "version") {
    console.log(`agentroam ${VERSION}`);
    return;
  }
  if (options.command === "doctor") {
    await doctor(target, options.dataDir);
    return;
  }

  console.log(`AgentRoam ${VERSION}\n✓ Node ${process.versions.node} · ${target}`);
  const pairing = createPairingSecret();
  const controller = new AbortController();
  let runtime: RuntimeHandle | null = null;
  let relay: RelaySelection | null = null;
  let closing = false;

  const close = async () => {
    if (closing) return;
    closing = true;
    controller.abort();
    await relay?.tunnel?.close().catch(() => {});
    await runtime?.close().catch(() => {});
  };
  const requestClose = () => void close();
  process.once("SIGINT", requestClose);
  process.once("SIGTERM", requestClose);

  try {
    runtime = await new RuntimeManager().start(options, pairing);
    console.log(`✓ Local server: ${runtime.localUrl}/web`);
    const lanUrl = findLanUrl(runtime.port) ?? runtime.localUrl;

    relay = await selectRelay({
      cli: options,
      target,
      localUrl: runtime.localUrl,
      lanUrl,
      port: runtime.port,
      signal: controller.signal,
      log: (line) => process.stderr.write(`${line}\n`),
      onAttempt: (provider) => console.log(`▲ Trying ${providerDisplayName(provider)} relay...`),
      onFailure: (provider, message) => console.error(`⚠ ${providerDisplayName(provider)} unavailable: ${message}`),
    });

    if (controller.signal.aborted) return;
    if (relay.provider === "lan") {
      if (relay.failures.length > 0) console.error(`  Continuing with local network access: ${relay.publicUrl}/web`);
      else console.log(`✓ Local network: ${relay.publicUrl}/web`);
    } else {
      console.log(`✓ ${providerDisplayName(relay.provider)} tunnel ready: ${relay.publicUrl}`);
    }

    if (relay.provider === "pinggy") {
      console.log("  Pinggy free tunnels expire after 60 minutes and use a new hostname each session.");
      console.log("  The phone browser may show a one-time Pinggy security confirmation before pairing.");
    }

    const accessUrl = `${relay.publicUrl}/web${runtime.needsSetup ? `?pair=${encodeURIComponent(pairing.token)}` : ""}`;
    console.log(`\nOpen: ${accessUrl}`);
    if (options.qr) console.log(`\n${await renderQr(accessUrl)}`);
    if (runtime.needsSetup) console.log("First pairing link expires in 5 minutes.");
    console.log("Ctrl+C stops the tunnel and local server.");

    await Promise.race([runtime.exited, relay.tunnel?.exited ?? new Promise(() => {})]);
  } finally {
    process.removeListener("SIGINT", requestClose);
    process.removeListener("SIGTERM", requestClose);
    await close();
  }
}

async function doctor(target: PlatformTarget, dataDir: string): Promise<void> {
  console.log(`✓ Node ${process.versions.node}`);
  console.log(`✓ Platform ${target}`);
  const runtimeRoot = fileURLToPath(new URL("../runtime/", import.meta.url));
  const runtimeRequire = createRequire(fileURLToPath(new URL("../runtime/package.json", import.meta.url)));

  try {
    await repairNativeRuntimePermissions(runtimeRoot);
    console.log("✓ node-pty spawn-helper executable");
  } catch (error) {
    reportDoctorFailure(error);
  }

  for (const module of ["node-pty", "better-sqlite3"]) {
    try {
      runtimeRequire(module);
      console.log(`✓ ${module}`);
    } catch (error) {
      reportDoctorFailure(error, `${module}: `);
    }
  }

  try {
    runtimeRequire.resolve("agentroam-tui-darwin-arm64/entry");
    console.log("✓ agent-tui optional package");
  } catch (error) {
    reportDoctorFailure(error, "agent-tui: ");
  }

  try {
    const executable = await ensureCloudflared(target, dataDir);
    console.log(`✓ cloudflared ${executable}`);
  } catch (error) {
    reportDoctorFailure(error, "cloudflared: ");
  }
  console.log(`✓ Data directory ${dataDir}`);
}

function reportDoctorFailure(error: unknown, prefix = ""): void {
  console.log(`✗ ${prefix}${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}

function providerDisplayName(provider: Exclude<RelaySelection["provider"], "lan">): string {
  if (provider === "cloudflare") return "Cloudflare";
  if (provider === "pinggy") return "Pinggy";
  return "Custom";
}
