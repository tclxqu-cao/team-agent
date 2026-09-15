import { printLocalDesktopUrl } from './local-desktop-url.js';
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./args.js";
import { ensureCloudflared } from "./cloudflared/installer.js";
import { resolveCodexRuntime } from "./codex-runtime-manager.js";
import { probeSQLiteRuntime, probeTerminalRuntime, repairNativeRuntimePermissions } from "./native-runtime.js";
import { findLanUrl } from "./network.js";
import { installedDataDir, pairingAdmin, printPairingCode, type PairedDevice, type PendingPairing, terminalText } from "./device-pairing.js";
import { detectPlatform, type PlatformTarget } from "./platform.js";
import { AGENTROAM_VERSION, resolvePlatformRuntime, resolvePlatformTui } from "./platform-packages.js";
import { acquireSleepInhibitor } from "./power/sleep-inhibitor.js";
import { RuntimeManager, type RuntimeHandle } from "./runtime-manager.js";
import { ServiceRuntimeReporter } from "./service/runtime-state.js";
import { runServiceCommand } from "./service/service-command.js";
import { resolveServicePaths } from "./service/service-files.js";
import { selectRelay, type RelaySelection } from "./tunnel/relay-orchestrator.js";
import { currentCliPath, startUpdate } from "./update/update-command.js";
import { runUpdateWorker } from "./update/update-worker.js";
import { lockInstanceStartup, stopPreviousInstances } from "./instance-takeover.js";

const VERSION = AGENTROAM_VERSION;

export async function main(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`AgentRoam
  agentroam [start] [--local-only] [--test-no-pairing] [--data-dir PATH]
  agentroam pair                    生成一次性设备配对码
  agentroam pair --url <服务器地址>   生成 App 扫码直连授权（终端显示）
  agentroam approvals               查看待批准请求和核对短语
  agentroam approve <请求ID> --phrase <核对短语>
  agentroam deny <请求ID>             拒绝请求
  agentroam lock                    紧急锁定全部远程访问
  agentroam unlock                  本机解锁（需要重新配对）
  agentroam audit                   查看安全审计记录
  agentroam devices                 查看已授权设备
  agentroam revoke <设备ID>          移除一台设备
  agentroam revoke --all            全部退出并取消待用配对码
  agentroam service install|start|stop|restart|status|url|logs|uninstall
设备命令支持 --data-dir PATH；配对码有效期 5 分钟，设备授权有效期 30 天。`);
    return;
  }
  const options = parseArgs(argv);
  if (["pair", "devices", "revoke", "approvals", "approve", "deny", "lock", "unlock", "audit"].includes(options.command)) {
    const dataDir = argv.includes("--data-dir") ? options.dataDir : await installedDataDir(options.dataDir);
    if (options.command === "pair") await printPairingCode(dataDir, console.log, { accessUrl: options.pairingUrl, qr: options.qr });
    else if (options.command === "approvals") {
      const { requests, locked } = await pairingAdmin<{ requests: PendingPairing[]; locked: boolean }>(dataDir, "requests");
      console.log(locked ? "远程访问已锁定" : requests.length ? requests.map((r) => `${r.id}  ${terminalText(r.name)}  核对短语：${r.phrase}  到期 ${new Date(r.expires).toLocaleString()}`).join("\n") : "暂无待授权请求");
    } else if (options.command === "approve" || options.command === "deny") {
      await pairingAdmin(dataDir, options.command, { id: options.approvalRequestId, phrase: options.approvalPhrase });
      console.log(options.command === "approve" ? "已批准，手机将自动进入。" : "已拒绝此设备。");
    } else if (options.command === "lock" || options.command === "unlock") {
      await pairingAdmin(dataDir, options.command);
      console.log(options.command === "lock" ? "远程访问已锁定，设备授权和待用配对已取消。已提交的本机任务不会自动终止。" : "远程访问已解锁。旧设备不会恢复授权，请执行 agentroam pair 重新配对。");
    } else if (options.command === "audit") {
      const { events } = await pairingAdmin<{ events: { at: number; action: string; actor: string | null; target: string | null; outcome: string; count: number }[] }>(dataDir, "audit");
      console.log(events.length ? events.map((e) => `${new Date(e.at).toISOString()} ${e.action} ${e.outcome} actor=${e.actor ?? "-"} target=${e.target ?? "-"} count=${e.count}`).join("\n") : "暂无审计记录");
    } else if (options.command === "devices") {
      const { devices } = await pairingAdmin<{ devices: PairedDevice[] }>(dataDir, "devices");
      console.log(devices.length ? devices.map((d) => `${d.id}  ${d.name.replace(/[\x00-\x1f\x7f-\x9f]/g, "")}  最近使用 ${new Date(d.seen).toLocaleString()}  到期 ${new Date(d.expires).toLocaleString()}`).join("\n") : "暂无已授权设备");
      console.log("移除设备：agentroam revoke <设备ID>；全部退出：agentroam revoke --all");
    } else {
      const result = await pairingAdmin<{ revoked: number }>(dataDir, "revoke", options.revokeAll ? { all: true } : { id: options.revokeDeviceId });
      console.log(`已撤销 ${result.revoked} 台设备的授权`);
    }
    return;
  }
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
  const controller = new AbortController();
  let runtime: RuntimeHandle | null = null;
  let relay: RelaySelection | null = null;
  let closing = false;
  let releaseStartup: (() => Promise<void>) | undefined;
  let closePromise: Promise<void> | undefined;
  let reportedStarting = false;
  const serviceReporter = process.env.AGENTROAM_SERVICE === "1"
    ? new ServiceRuntimeReporter(resolveServicePaths(undefined, options.dataDir), VERSION)
    : null;

  const close = () => {
    if (closePromise) return closePromise;
    closing = true;
    controller.abort();
    closePromise = (async () => {
      await relay?.tunnel?.close().catch(() => {});
      await runtime?.close().catch(() => {});
    })();
    return closePromise;
  };
  const requestClose = () => void close();
  process.once("SIGINT", requestClose);
  process.once("SIGTERM", requestClose);

  try {
    releaseStartup = await lockInstanceStartup(options.dataDir);
    await stopPreviousInstances(options.dataDir, console.log);
    if (controller.signal.aborted) return;
    await serviceReporter?.starting();
    reportedStarting = Boolean(serviceReporter);
    runtime = await new RuntimeManager().start(options, target);
    if (controller.signal.aborted) { await runtime.close(); return; }
    void runtime.exited.then(() => controller.abort());
    console.log(`✓ Local server: ${runtime.localUrl}/web`);
    await serviceReporter?.localReady(runtime.localUrl);
    if (!serviceReporter) printLocalDesktopUrl(runtime.localUrl);
    const lanUrl = options.localOnly ? findLanUrl(runtime.port) ?? runtime.localUrl : runtime.localUrl;

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
      allowLanFallback: options.localOnly,
    });

    if (controller.signal.aborted) { await relay.tunnel?.close(); return; }
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

    const accessUrl = `${relay.publicUrl}/web`;
    await serviceReporter?.ready({
      localUrl: runtime.localUrl,
      publicUrl: relay.publicUrl,
      accessUrl,
      provider: relay.provider,
    });
    await releaseStartup();
    if (serviceReporter) {
      console.log("✓ Background service URL written to the private state file.");
    } else {
      console.log(`\nOpen: ${accessUrl}`);
      if (!options.testNoPairing) await printPairingCode(options.dataDir, console.log, { signal: controller.signal, accessUrl, qr: options.qr });
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
    await releaseStartup?.();
    if (reportedStarting) await serviceReporter?.stopped().catch(() => {});
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
