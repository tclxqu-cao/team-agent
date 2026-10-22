import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CliOptions } from "./args.js";
import type { CodexSharingStatus } from "./codex-sharing.js";
import { withDesktopRpc } from "./codex-desktop-probe.js";
import { ensureWindowsBackend, readWindowsBackend, WINDOWS_CODEX_TASK } from "./codex-windows-backend.js";

const executeFile = promisify(execFile);
interface WindowsContext {
  environment?: NodeJS.ProcessEnv;
  execute?: typeof executeFile;
  probe?: (endpoint: string) => Promise<void>;
  log?: (message: string) => void;
  backend?: typeof ensureWindowsBackend;
  readBackend?: typeof readWindowsBackend;
}

export function windowsSharingEndpoint(environment: NodeJS.ProcessEnv): string | null {
  const endpoint = environment.AGENT_CODEX_DESKTOP_WS_URL || environment.CODEX_APP_SERVER_WS_URL;
  if (!endpoint) return null;
  const url = new URL(endpoint);
  if (url.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.search || url.hash) throw new Error("Windows 共享后端必须使用无凭据的本机 WebSocket 地址。");
  return url.href;
}

export function powershellLiteral(value: string): string { return `'${value.replaceAll("'", "''")}'`; }

export async function runWindowsCodexDesktop(options: CliOptions, context: WindowsContext = {}): Promise<CodexSharingStatus> {
  const environment = { ...(context.environment ?? process.env) };
  const log = context.log ?? console.log;
  const execute = context.execute ?? executeFile;
  const run = (script: string) => execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference='Stop'; ${script}`],
    { env: environment, encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024, windowsHide: true });
  const report: CodexSharingStatus = { state: "unsupported", configured: false, autoStart: false, daemonReachable: false,
    message: "Windows 共享后台尚未就绪；已保留 Codex，不会强制重启。" };
  let endpoint = windowsSharingEndpoint(environment);
  if (!endpoint) {
    const config = options.desktopSharingStatus || options.desktopDryRun
      ? await (context.readBackend ?? readWindowsBackend)()
      : await (context.backend ?? ensureWindowsBackend)(options.dataDir, { environment, execute });
    if (config) { endpoint = config.endpoint; environment.CODEX_HOME = config.codexHome; }
  }
  if (!endpoint) { report.state = "failed"; report.message = "Windows 共享后台尚未配置，请运行安装或点击检查并修复。"; log(JSON.stringify(report)); return report; }
  environment.AGENT_CODEX_DESKTOP_WS_URL = endpoint;
  let binary = environment.CODEX_DESKTOP_APP;
  if (!binary) {
    const { stdout } = await run(`$candidates=@(); $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('Codex.exe','ChatGPT.exe') -and $_.CommandLine -notmatch '--type=' } | ForEach-Object { if ((Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid).Sid -eq $sid) { $candidates += $_.ExecutablePath } }; Get-AppxPackage | Where-Object { $_.Name -match 'OpenAI.*(Codex|ChatGPT)' } | ForEach-Object { $root=$_.InstallLocation; $manifest=Get-AppxPackageManifest $_; $manifest.Package.Applications.Application | ForEach-Object { if ($_.Executable) { $candidates += Join-Path $root $_.Executable } } }; $candidates += @((Join-Path $env:LOCALAPPDATA 'Programs\\Codex\\Codex.exe'),(Join-Path $env:LOCALAPPDATA 'Programs\\ChatGPT\\ChatGPT.exe')); foreach($candidate in ($candidates | Select-Object -Unique)) { if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf) -and [IO.Path]::GetFileName($candidate) -in @('Codex.exe','ChatGPT.exe')) { $signature=Get-AuthenticodeSignature -LiteralPath $candidate; if ($signature.Status -eq 'Valid' -and $signature.SignerCertificate.Subject -match 'OpenAI') { Write-Output $candidate; break } } }`);
    binary = stdout.trim() || undefined;
  }
  if (!binary || !/^[A-Za-z]:\\.*\.exe$/i.test(binary)) {
    report.state = "not-installed";
    report.message = "未找到当前用户安装的官方 Codex 桌面端；不会结束其他程序。";
    log(JSON.stringify(report)); return report;
  }
  const encodedBinary = powershellLiteral(binary);
  const { stdout: supported } = await run(`$signature=Get-AuthenticodeSignature -LiteralPath ${encodedBinary}; if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'OpenAI') { throw 'Not an official signed Desktop executable' }; $archive=Join-Path (Split-Path ${encodedBinary}) 'resources\\app.asar'; if (Test-Path -LiteralPath $archive) { $text=[Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($archive)); if ($text.Contains('CODEX_APP_SERVER_WS_URL')) { 'supported' } }`);
  if (supported.trim() !== "supported") { report.message = "当前 Windows 官方桌面版本未提供可确认的共享连接能力，已保留进程。"; log(JSON.stringify(report)); return report; }
  const processes = async () => {
    const { stdout } = await run(`$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; @((Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq ${encodedBinary} -and $_.CommandLine -notmatch '--type=' -and (Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid).Sid -eq $sid }) | Select-Object ProcessId,@{Name='CreationDate';Expression={$_.CreationDate.ToString('o')}},ExecutablePath) | ConvertTo-Json -Compress`);
    const rows = JSON.parse(stdout.trim() || "[]");
    return (Array.isArray(rows) ? rows : [rows]) as Array<{ ProcessId: number; CreationDate: string; ExecutablePath: string }>;
  };
  const initial = await processes();
  if (initial.length > 1) throw new Error("检测到多个 Codex 桌面实例，无法安全确定重启目标。");
  report.backendEndpoint = endpoint;
  const { stdout: task } = await run(`$task=Get-ScheduledTask -TaskName '${WINDOWS_CODEX_TASK}' -ErrorAction SilentlyContinue; if ($task -and $task.State -eq 'Running') { 'running' }`);
  report.autoStart = task.trim() === "running";
  report.state = initial.length ? "independent" : "stopped";
  if (!options.desktopDryRun) {
    await (context.probe ?? (async url => { await withDesktopRpc(url, async request => { await request("config/read", { includeLayers: false }); }); }))(endpoint);
    report.daemonReachable = true;
  }
  const { stdout: defaults } = await run(`[Environment]::GetEnvironmentVariable('CODEX_APP_SERVER_WS_URL','User')`);
  report.configured = defaults.trim() === endpoint;
  if (initial.length && report.daemonReachable) {
    const port = new URL(endpoint).port || "80";
    const { stdout } = await run(`$listeners=@(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue); if ($listeners.Count -eq 0 -or @($listeners | Where-Object { $_.LocalAddress -notin @('127.0.0.1','::1') -or $_.OwningProcess -eq ${initial[0]!.ProcessId} }).Count -gt 0) { throw 'Shared endpoint ownership unavailable' }; $ids=@(${initial[0]!.ProcessId}); $family=@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq ${encodedBinary} }); do { $added=@($family | Where-Object { $_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids } | ForEach-Object { $_.ProcessId }); $ids += $added } while ($added.Count -gt 0); @(Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -in $ids -and $_.RemotePort -eq ${port} -and $_.RemoteAddress -in @('127.0.0.1','::1') }).Count`);
    if (Number(stdout.trim()) > 0) report.state = "shared";
  }
  report.message = report.state === "shared" ? "Codex 已连接配置的共享后台。" : report.state === "stopped" ? "共享后端可用；Codex 桌面保持关闭。" : "Codex 未连接共享后台；Windows 暂无法可靠判断桌面任务，切换前需要确认强制重启。";
  if (options.desktopDryRun) { log(JSON.stringify({ ...report, message: "Dry run: 未写配置、未启动或结束任何进程。" })); return report; }
  if (options.desktopSharingStatus) { log(JSON.stringify(report)); return report; }
  await run(`[Environment]::SetEnvironmentVariable('CODEX_APP_SERVER_WS_URL',${powershellLiteral(endpoint)},'User'); [Environment]::SetEnvironmentVariable('CODEX_APP_SERVER_FORCE_CLI','0','User')`);
  await run(`Add-Type -Namespace AgentRoam -Name EnvironmentBroadcast -MemberDefinition '[DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);'; $result=[UIntPtr]::Zero; [AgentRoam.EnvironmentBroadcast]::SendMessageTimeout([IntPtr]0xffff,0x1a,[UIntPtr]::Zero,'Environment',2,3000,[ref]$result) | Out-Null`);
  report.configured = true;
  if (options.desktopRepair || report.state === "shared") { log(JSON.stringify(report)); return report; }
  if (options.desktopSetup && report.state === "stopped") { log(JSON.stringify(report)); return report; }
  if (initial.length && !options.desktopRestart) {
    if (options.desktopSetup && environment.AGENTROAM_CODEX_DESKTOP_NONINTERACTIVE === "1") {
      log(JSON.stringify({ codexSharingAction: "confirmation-required" })); log(JSON.stringify(report)); return report;
    }
    throw new Error("Windows 桌面任务状态无法确认。请确认中断风险后使用 --restart；不会自动结束进程。");
  }
  if (initial.length) {
    const target = initial[0]!;
    if (!Number.isSafeInteger(target.ProcessId) || target.ProcessId <= 1) throw new Error("无效的桌面 PID");
    await run(`$target=Get-CimInstance Win32_Process -Filter 'ProcessId=${target.ProcessId}'; if (!$target -or $target.ExecutablePath -ne ${encodedBinary} -or $target.CreationDate.ToString('o') -ne ${powershellLiteral(String(target.CreationDate))}) { throw 'Desktop process identity changed' }; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; if ((Invoke-CimMethod -InputObject $target -MethodName GetOwnerSid).Sid -ne $sid) { throw 'Desktop user changed' }; $root=(Split-Path ${encodedBinary}) + '\\'; $private=@(Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${target.ProcessId} -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root,[StringComparison]::OrdinalIgnoreCase) -and $_.Name -eq 'codex.exe' -and $_.CommandLine -match '\\sapp-server(?:\\s|$)' -and $_.CommandLine -notmatch '\\s(proxy|daemon)(?:\\s|$)|--managed-daemon' }); foreach($child in $private) { $live=Get-CimInstance Win32_Process -Filter "ProcessId=$($child.ProcessId)"; if (!$live -or $live.CreationDate -ne $child.CreationDate -or $live.ParentProcessId -ne ${target.ProcessId} -or $live.ExecutablePath -ne $child.ExecutablePath) { throw 'Private backend identity changed' }; Stop-Process -Id $child.ProcessId -Force }; Stop-Process -Id ${target.ProcessId} -Force; Wait-Process -Id ${target.ProcessId} -Timeout 10 -ErrorAction SilentlyContinue; if (Get-Process -Id ${target.ProcessId} -ErrorAction SilentlyContinue) { throw 'Desktop did not exit' }`);
  }
  await run(`$env:CODEX_APP_SERVER_WS_URL=${powershellLiteral(endpoint)}; ${environment.CODEX_HOME ? `$env:CODEX_HOME=${powershellLiteral(environment.CODEX_HOME)}; ` : ''}$env:CODEX_APP_SERVER_FORCE_CLI='0'; Start-Process -FilePath ${encodedBinary}`);
  report.state = "failed";
  report.message = "已请求共享启动；请刷新并验证实际连接，尚不能确认共享成功。";
  log(JSON.stringify(report));
  return report;
}
