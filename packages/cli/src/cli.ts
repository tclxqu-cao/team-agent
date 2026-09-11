import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./args.js";
import { ensureCloudflared } from "./cloudflared/installer.js";
import { resolveCodexRuntime } from "./codex-runtime-manager.js";
import { probeSQLiteRuntime, probeTerminalRuntime, repairNativeRuntimePermissions } from "./native-runtime.js";
import { findLanUrl } from "./network.js";
import { createPairingSecret } from "./pairing.js";
import { detectPlatform, type PlatformTarget } from "./platform.js";
import { AGENTROAM_VERSION, resolvePlatformRuntime, resolvePlatformTui } from "./platform-packages.js";
import { acquireSleepInhibitor } from "./power/sleep-inhibitor.js";
import { renderQr } from "./qr.js";
import { RuntimeManager, type RuntimeHandle } from "./runtime-manager.js";
import { ServiceRuntimeReporter } from "./service/runtime-state.js";
import { runServiceCommand } from "./service/service-command.js";
import { resolveServicePaths } from "./service/service-files.js";
import { selectRelay, type RelaySelection } from "./tunnel/relay-orchestrator.js";
import { currentCliPath, startUpdate } from "./update/update-command.js";
import { runUpdateWorker } from "./update/update-worker.js";

const VERSION = AGENTROAM_VERSION;

export async function main(argv: string[]): Promise<void> {
  const options = parseArgs(argv);
  if (options.command === "update-worker") {
    await runUpdateWorker(options.updateStateFile!);
    return;
  }
  if (options.command === "service") {
    await runServiceCommand(options, {
      nodePath: process.execPath,
      cliPath: fileURLToPath(new URL("../bin/agentroam.mjs", import.meta.url)),
      version: VERSION,
    });
    return;
  }
  const target = detectPlatform();

  if (options.command === "update") {
    if (target !== "darwin-arm64" && target !== "windows-amd64") throw new Error(`updates are unavailable for ${target}`);
    const state = await startUpdate({ currentVersion: VERSION, requestedVersion: options.updateVersion ?? null, dataDir: options.dataDir, target, cliPath: currentCliPath() });
    console.log(`AgentRoam ${state.targetVersion} update started in the background.`);
    return;
  }

  if (options.command === "version") {
    console.log(`agentroam ${VERSION}`);
    return;
  }
  if (options.command === "doctor") {
    await doctor(target, options.dataDir);
    return;
  }

  console.log(`AgentRoam ${VERSION}\n✓ Node ${process.versions.node} · ${target}`);
  const sleepInhibitor = await acquireSleepInhibitor();
  const pairing = createPairingSecret();
  const controller = new AbortController();
  let runtime: RuntimeHandle | null = null;
  let relay: RelaySelection | null = null;
  let closing = false;
  const serviceReporter = process.env.AGENTROAM_SERVICE === "1"
    ? new ServiceRuntimeReporter(resolveServicePaths(undefined, options.dataDir), VERSION)
    : null;

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
    await serviceReporter?.starting();
    runtime = await new RuntimeManager().start(options, pairing, target);
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
      allowLanFallback: serviceReporter === null,
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
    await serviceReporter?.ready({
      localUrl: runtime.localUrl,
      publicUrl: relay.publicUrl,
      accessUrl,
      provider: relay.provider,
    });
    if (serviceReporter) {
      console.log("✓ Background service URL written to the private state file.");
    } else {
      console.log(`\nOpen: ${accessUrl}`);
      if (options.qr) console.log(`\n${await renderQr(accessUrl)}`);
      if (runtime.needsSetup) console.log("First pairing link expires in 5 minutes.");
      console.log("Ctrl+C stops the tunnel and local server.");
    }

    await Promise.race([
      runtime.exited,
      relay.tunnel?.exited ?? new Promise(() => {}),
      sleepInhibitor.lost.then(async (error) => {
        await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
        if (!closing) throw error;
      }),
    ]);
  } finally {
    process.removeListener("SIGINT", requestClose);
    process.removeListener("SIGTERM", requestClose);
    await close();
    await serviceReporter?.stopped().catch(() => {});
    await sleepInhibitor.release();
  }
}

async function doctor(target: PlatformTarget, dataDir: string): Promise<void> {
  console.log(`✓ Node ${process.versions.node} · Node-API ${process.versions.napi}`);
  console.log(`✓ Platform ${target}`);
  const { runtimeRoot } = resolvePlatformRuntime(target);
  const runtimeRequire = createRequire(`${runtimeRoot}/package.json`);

  try {
    await repairNativeRuntimePermissions(runtimeRoot);
    console.log("✓ node-pty spawn-helper executable");
  } catch (error) {
    reportDoctorFailure(error);
  }

  for (const [module, probe] of [
    ["node-pty", probeTerminalRuntime],
    ["better-sqlite3", probeSQLiteRuntime],
  ] as const) {
    try {
      await probe(runtimeRequire);
      console.log(`✓ ${module}`);
    } catch (error) {
      reportDoctorFailure(error, `${module}: `);
    }
  }

  try {
    resolvePlatformTui(target);
    console.log("✓ agent-tui optional package");
  } catch (error) {
    reportDoctorFailure(error, "agent-tui: ");
  }

  try {
    const codex = await resolveCodexRuntime({
      dataDir,
      target,
      onProgress: (message) => console.log(`… ${message}`),
    });
    console.log(`✓ Codex ${codex.version} (${codex.source}) ${codex.executable}`);
  } catch (error) {
    reportDoctorFailure(error, "Codex: ");
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
