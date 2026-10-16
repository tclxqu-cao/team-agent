import { execFile } from "node:child_process";
import { access, mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { ensureManagedNode } from "../../cli/src/node-runtime-manager";
import cliPackage from "../../cli/package.json";
import desktopPackage from "../package.json";
import { verifyDesktopRuntime } from "./runtime-inventory.mjs";
import { bundledRuntimePackages } from "./bundled-runtime.mjs";
import { runtimeServiceArguments } from "./runtime-service-args.mjs";

const execute = promisify(execFile);
const progress = (message: string) => process.stdout.write(`${JSON.stringify({ message })}\n`);

async function main() {
  const target = process.platform === "darwin" && process.arch === "arm64" ? "darwin-arm64"
    : process.platform === "win32" && process.arch === "x64" ? "windows-amd64" : null;
  if (!target) throw new Error("当前系统不支持自动准备运行环境。");
  const dataDir = join(homedir(), ".agentroam");
  const runtimePackage = target === "darwin-arm64" ? "agentroam-runtime-darwin-arm64" : "agentroam-runtime-win32-x64";
  const runtimeVersion = cliPackage.optionalDependencies[runtimePackage];
  let bundled: string[];
  try {
    bundled = await bundledRuntimePackages(join(dirname(fileURLToPath(import.meta.url)), "../runtime"), target, cliPackage.version, runtimeVersion);
  } catch {
    throw Object.assign(new Error("Desktop runtime bundle is incompatible"), { code: "RUNTIME_INCOMPATIBLE" });
  }
  progress("正在准备 Node.js 运行环境…");
  const node = await ensureManagedNode({ dataDir, target, onProgress: () => {} });
  const bin = dirname(node.executable);
  const npm = process.platform === "win32" ? join(bin, "node_modules/npm/bin/npm-cli.js") : join(bin, "../lib/node_modules/npm/bin/npm-cli.js");
  const installation = join(dataDir, "desktop-cli", `${desktopPackage.version}-${cliPackage.version}`);
  const cli = join(installation, "node_modules/agentroam/bin/agentroam.mjs");
  const environment: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH || ""}`, AGENTROAM_MANAGED_NODE: node.executable, AGENTROAM_DATA_DIR: dataDir, AGENTROAM_INSTALL_REMOTE_DESKTOP: "skip" };
  delete environment.ELECTRON_RUN_AS_NODE;
  await mkdir(installation, { recursive: true });
  let installed = false;
  try {
    installed = JSON.parse(await readFile(join(installation, "node_modules/agentroam/package.json"), "utf8")).version === cliPackage.version;
    if (installed) await verifyDesktopRuntime(installation, target, runtimeVersion);
  } catch { installed = false; }
  if (!installed) {
    progress("正在安装终端、远程桌面和后台服务组件…");
    // Only this versioned bootstrap directory belongs to the desktop installer.
    // Removing its modules lets a retry repair partial/corrupted npm installs.
    await rm(join(installation, "node_modules"), { recursive: true, force: true });
    await execute(node.executable, [npm, "install", "--prefix", installation, ...bundled, "--registry=https://registry.npmjs.org", "--include=optional", "--omit=dev", "--no-audit", "--no-fund"], { env: environment, cwd: homedir(), windowsHide: true, timeout: 12 * 60_000, maxBuffer: 2 * 1024 * 1024 });
  }
  progress("正在校验终端和远程桌面组件…");
  await verifyDesktopRuntime(installation, target, runtimeVersion);
  progress("正在检查终端并准备 Codex，首次下载可能需要几分钟…");
  await execute(node.executable, [cli, "doctor", "--data-dir", dataDir], { env: environment, cwd: homedir(), windowsHide: true, timeout: 5 * 60_000, maxBuffer: 2 * 1024 * 1024 });
  progress("正在启动 AgentRoam 后台服务…");
  let configured = false;
  try { await access(join(homedir(), ".agentroam/service/config.json")); configured = true; } catch {}
  await execute(node.executable, runtimeServiceArguments(cli, dataDir, homedir(), configured), { env: environment, cwd: homedir(), windowsHide: true, timeout: 6 * 60_000, maxBuffer: 2 * 1024 * 1024 });
  progress("运行组件已准备好，正在连接工作区…");
}

main().catch((error: unknown) => {
  if (error && typeof error === "object" && "code" in error && error.code === "RUNTIME_INCOMPATIBLE") {
    process.stdout.write(`${JSON.stringify({ error: "runtime-incompatible" })}\n`);
  }
  // Child output can include pairing grants. Only expose the safe stage message.
  process.stderr.write("运行环境准备失败，请检查网络后重试。\n");
  process.exitCode = 1;
});
