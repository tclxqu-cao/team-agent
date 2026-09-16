import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { resolve } from "node:path";

export type UnlockServiceAction = "install" | "uninstall" | "status";

const SERVICE_NAME = "AgentRoamUnlock";
const DISPLAY_NAME = "AgentRoam Remote Unlock";

type Runner = (
  file: string,
  args: readonly string[],
  options: { encoding: "utf8"; windowsHide: true },
) => SpawnSyncReturns<string>;

function psQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function encodePowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

export function unlockServiceExecutable(runtimeRoot: string): string {
  return resolve(runtimeRoot, "native", "agentroam-remote-unlock.exe");
}

export function buildUnlockServiceAdminScript(action: Exclude<UnlockServiceAction, "status">, executable: string): string {
  const common = `$ErrorActionPreference = 'Stop'\n$serviceName = '${SERVICE_NAME}'`;
  if (action === "uninstall") {
    return `${common}
$service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($service) {
  if ($service.Status -ne 'Stopped') { Stop-Service -Name $serviceName -Force -ErrorAction Stop }
  & "$env:SystemRoot\\System32\\sc.exe" delete $serviceName | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "sc.exe delete failed: $LASTEXITCODE" }
}
`;
  }
  const binaryPath = `\"${executable}\" --service`;
  return `${common}
$binary = ${psQuote(executable)}
if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) { throw "Remote unlock helper is missing: $binary" }
$service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($service) {
  if ($service.Status -ne 'Stopped') { Stop-Service -Name $serviceName -Force -ErrorAction Stop }
  & "$env:SystemRoot\\System32\\sc.exe" delete $serviceName | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "sc.exe delete failed: $LASTEXITCODE" }
  for ($attempt = 0; $attempt -lt 50 -and (Get-Service -Name $serviceName -ErrorAction SilentlyContinue); $attempt++) { Start-Sleep -Milliseconds 100 }
}
New-Service -Name $serviceName -BinaryPathName ${psQuote(binaryPath)} -DisplayName '${DISPLAY_NAME}' -StartupType Automatic | Out-Null
& "$env:SystemRoot\\System32\\sc.exe" description $serviceName "Allows an authorized AgentRoam session to wake and unlock the Windows secure desktop." | Out-Null
Start-Service -Name $serviceName -ErrorAction Stop
`;
}

export function buildElevatedPowerShell(adminScript: string): string {
  const payload = encodePowerShell(adminScript);
  return `$ErrorActionPreference = 'Stop'
$powershell = Join-Path $PSHOME 'powershell.exe'
$process = Start-Process -FilePath $powershell -Verb RunAs -Wait -PassThru -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','${payload}')
exit $process.ExitCode
`;
}

export function parseUnlockServiceStatus(output: string): "running" | "stopped" | "missing" {
  const value = output.trim().split(/\r?\n/).at(-1)?.trim().toLowerCase();
  if (value === "running" || value === "stopped" || value === "missing") return value;
  throw new Error("无法读取远程解锁服务状态");
}

function runPowerShell(script: string, runner: Runner): SpawnSyncReturns<string> {
  return runner("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-EncodedCommand", encodePowerShell(script),
  ], { encoding: "utf8", windowsHide: true });
}

export function queryUnlockServiceStatus(runner: Runner = spawnSync): "running" | "stopped" | "missing" {
  const script = `$service = Get-Service -Name '${SERVICE_NAME}' -ErrorAction SilentlyContinue
if (-not $service) { Write-Output 'missing' } elseif ($service.Status -eq 'Running') { Write-Output 'running' } else { Write-Output 'stopped' }
`;
  const result = runPowerShell(script, runner);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || "远程解锁服务状态查询失败").trim());
  return parseUnlockServiceStatus(result.stdout || "");
}

export function runUnlockServiceCommand(
  action: UnlockServiceAction,
  runtimeRoot: string,
  options: { platform?: NodeJS.Platform; runner?: Runner; log?: (message: string) => void } = {},
): void {
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? spawnSync;
  const log = options.log ?? console.log;
  if (platform !== "win32") throw new Error("远程解锁服务仅支持 Windows 10/11 x64");
  if (action === "status") {
    const status = queryUnlockServiceStatus(runner);
    log(status === "running" ? "远程解锁服务正在运行" : status === "stopped" ? "远程解锁服务已安装但未运行" : "远程解锁服务未安装");
    return;
  }
  const executable = unlockServiceExecutable(runtimeRoot);
  const result = runPowerShell(buildElevatedPowerShell(buildUnlockServiceAdminScript(action, executable)), runner);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || (action === "install" ? "远程解锁服务安装失败或已取消管理员授权" : "远程解锁服务卸载失败或已取消管理员授权")).trim());
  }
  const status = queryUnlockServiceStatus(runner);
  if (action === "install" && status !== "running") throw new Error("远程解锁服务安装后未能启动");
  if (action === "uninstall" && status !== "missing") throw new Error("远程解锁服务卸载后仍然存在");
  log(action === "install" ? "远程解锁服务已安装并启动" : "远程解锁服务已卸载");
}
