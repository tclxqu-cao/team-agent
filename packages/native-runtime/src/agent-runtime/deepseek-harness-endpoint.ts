import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { readHarnessLocalCookie } from "./deepseek-harness-local-auth.js";

const execFileAsync = promisify(execFile);
const COMMAND_OPTIONS = { encoding: "utf8" as const, timeout: 1_500, maxBuffer: 2 * 1024 * 1024 };

/** Borrowing an endpoint does not transfer process ownership to AgentRoam. */
export interface HarnessEndpoint { origin: string; cookie: string; refreshAt?: number }
export type HarnessEndpointResolver = () => Promise<HarnessEndpoint | null>;
type DiscoveryExecutor = (command: string, args: string[], options: typeof COMMAND_OPTIONS) => Promise<{ stdout: string }>;
interface HarnessProcess { pid: number; kind: "desktop" | "web" }

function processKind(command: string): HarnessProcess["kind"] | null {
  const normalized = command.replaceAll("\\", "/");
  const nodeLauncher = /^(?:"[^"\n]*\/(?:node|bun|dsh)(?:\.exe)?"|(?:\S*\/)?(?:node|bun|dsh)(?:\.exe)?)(?:\s|$)/.test(normalized);
  const desktopLauncher = /^(?:"?\/.*\/DeepSeek Harness\.app\/Contents\/MacOS\/DeepSeek Harness|"?[A-Za-z]:\/.*\/DeepSeek Harness\.exe)["']?(?:\s|$)/.test(normalized);
  if (!nodeLauncher && !desktopLauncher) return null;
  if (/@deepseek-ai\/dsh-desktop-host\/(?:lib|src)\/index\.(?:js|ts)(?:["']?\s|$)/.test(normalized)) return "desktop";
  const cli = /(?:@deepseek-ai\/dsh\/(?:lib\/bin\.js|src\/bin\.ts)|@deepseek-ai\/dsh-desktop-host\/lib\/cli\.js|(?:^|\s)(?:\S*\/)?dsh)(?:["']?\s+)(.*)$/.exec(normalized);
  if (!cli) return null;
  const args = cli[1]!;
  return /^(?:web|--profile(?:=|\s+)["']?(?:web|desktop)["']?)(?:\s|$)/.test(args)
    ? /(?:^|\s)--profile(?:=|\s+)["']?desktop(?:["']?\s|$)/.test(args) ? "desktop" : "web" : null;
}

export function selectHarnessProcesses(stdout: string, uid: number): HarnessProcess[] {
  return stdout.split("\n").flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match || Number(match[2]) !== uid) return [];
    const kind = processKind(match[3]!);
    return kind ? [{ pid: Number(match[1]), kind }] : [];
  }).sort((a, b) => Number(a.kind !== "desktop") - Number(b.kind !== "desktop") || a.pid - b.pid);
}

export function selectHarnessListenerOrigins(stdout: string, pid: number): string[] {
  let owner = 0;
  const origins = new Set<string>();
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) owner = Number(line.slice(1));
    if (owner !== pid) continue;
    const match = /^n(127\.0\.0\.1|localhost|\[::1\]):(\d+)$/.exec(line);
    if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) continue;
    origins.add(`http://${match[1]}:${match[2]}`);
  }
  return [...origins];
}

/** Probe a harmless RPC before borrowing a listener; a port or HTML response is not identity evidence. */
async function verifyEndpoint(endpoint: HarnessEndpoint, request: typeof fetch): Promise<boolean> {
  const rpcId = randomUUID();
  try {
    const response = await request(`${endpoint.origin}/api/session/list`, {
      method: "POST", redirect: "manual", headers: { "content-type": "application/json", cookie: endpoint.cookie },
      body: JSON.stringify({ type: "client-request", rpcId, method: "session/list", payload: { args: { _request: {} } } }),
      signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) return false;
    const envelope = await response.json();
    return envelope?.type === "server-response" && envelope.rpcId === rpcId
      && envelope.result?.ok === true && Array.isArray(envelope.result.value?.items);
  } catch { return false; }
}

/** Current-user process discovery stays in infrastructure; no filesystem or OS facts reach domain/UI code. */
export async function discoverHarnessEndpoint(options: {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  uid?: number;
  execute?: DiscoveryExecutor;
  readCookie?: (origin: string) => Promise<string | null>;
  request?: typeof fetch;
} = {}): Promise<HarnessEndpoint | null> {
  const platform = options.platform ?? process.platform;
  const execute = options.execute ?? execFileAsync as DiscoveryExecutor;
  const readCookie = options.readCookie ?? (origin => readHarnessLocalCookie(origin, options.environment));
  try {
    let candidates: { pid: number; origins: string[] }[];
    if (platform === "win32") {
      // Filter by the native process owner's SID before returning any command or listener.
      const script = "$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $rows=@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'dsh' } | ForEach-Object { if((Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid).Sid -eq $sid){ $p=$_; $ports=@(Get-NetTCPConnection -State Listen -OwningProcess $p.ProcessId -ErrorAction SilentlyContinue | Where-Object {$_.LocalAddress -eq '127.0.0.1' -or $_.LocalAddress -eq '::1'} | Select-Object LocalAddress,LocalPort); [pscustomobject]@{pid=$p.ProcessId;command=$p.CommandLine;ports=$ports} }}); ConvertTo-Json -InputObject $rows -Depth 4 -Compress";
      const { stdout } = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], COMMAND_OPTIONS);
      const rows: unknown = JSON.parse(stdout);
      if (!Array.isArray(rows)) return null;
      candidates = rows.flatMap(row => {
        const kind = typeof row?.command === "string" ? processKind(row.command) : null;
        if (!kind || !Number.isSafeInteger(row.pid) || !Array.isArray(row.ports)) return [];
        const listeners = `p${row.pid}\n` + row.ports.map((port: { LocalAddress: string; LocalPort: number }) => `n${port.LocalAddress === "::1" ? "[::1]" : port.LocalAddress}:${port.LocalPort}`).join("\n");
        return [{ pid: row.pid, kind, origins: selectHarnessListenerOrigins(listeners, row.pid) }];
      }).sort((a, b) => Number(a.kind !== "desktop") - Number(b.kind !== "desktop") || a.pid - b.pid);
    } else {
      const { stdout } = await execute("/bin/ps", ["-axo", "pid=,uid=,args="], COMMAND_OPTIONS);
      const processes = selectHarnessProcesses(stdout, options.uid ?? process.getuid?.() ?? -1);
      candidates = [];
      for (const candidate of processes) {
        try {
          const listeners = await execute(platform === "darwin" ? "/usr/sbin/lsof" : "lsof",
            ["-nP", "-a", "-p", String(candidate.pid), "-iTCP", "-sTCP:LISTEN", "-Fpn"], COMMAND_OPTIONS);
          candidates.push({ pid: candidate.pid, origins: selectHarnessListenerOrigins(listeners.stdout, candidate.pid) });
        } catch { /* A process can exit between the two snapshots. */ }
      }
    }
    for (const candidate of candidates) for (const origin of candidate.origins) {
      const cookie = await readCookie(origin);
      if (!cookie) continue;
      // Renew the short-lived native cookie before expiry without interrupting open streams.
      const endpoint = { origin, cookie, refreshAt: Date.now() + 4 * 60_000 };
      if (await verifyEndpoint(endpoint, options.request ?? fetch)) return endpoint;
    }
  } catch { /* Optional discovery can fall back to an owned Web host. */ }
  return null;
}
