import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DISCOVERY_TIMEOUT_MS = 1_500;

/** A borrowed connection: this endpoint never grants ownership of a process. */
export interface CodexDesktopEndpoint {
  webSocketUrl: string;
}

export type CodexDesktopEndpointResolver = () => Promise<CodexDesktopEndpoint | null>;

type DiscoveryExecutor = (
  command: string,
  args: string[],
  options: { encoding: "utf8"; timeout: number; maxBuffer: number },
) => Promise<{ stdout: string }>;

interface DesktopServer {
  pid: number;
  listenUrl: string;
}

export async function discoverCodexDesktopEndpoint(options: {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  execute?: DiscoveryExecutor;
} = {}): Promise<CodexDesktopEndpoint | null> {
  const override = (options.environment ?? process.env).AGENT_CODEX_DESKTOP_WS_URL?.trim();
  if (override) return { webSocketUrl: normalizeLocalEndpoint(override) };
  if ((options.platform ?? process.platform) !== "darwin") return null;

  const execute = options.execute ?? execFileAsync as DiscoveryExecutor;
  const commandOptions = {
    encoding: "utf8" as const,
    timeout: DISCOVERY_TIMEOUT_MS,
    maxBuffer: 2 * 1024 * 1024,
  };
  try {
    const { stdout } = await execute("/bin/ps", ["-axo", "pid=,ppid=,args="], commandOptions);
    const server = selectDesktopServer(stdout);
    if (!server) return null;
    if (server.listenUrl.startsWith("ws://")) {
      // A wildcard bind is reachable locally; never probe an external host.
      const address = new URL(server.listenUrl);
      if (address.hostname === "0.0.0.0" || address.hostname === "[::]") address.hostname = "localhost";
      if (address.port === "0") return null;
      const webSocketUrl = normalizeLocalEndpoint(address.href);
      const listeners = await execute(
        "/usr/sbin/lsof",
        ["-nP", "-a", "-p", String(server.pid), "-iTCP", "-sTCP:LISTEN", "-Ftn"],
        commandOptions,
      );
      const port = address.port || "80";
      const ownsListener = listeners.stdout.split("\n").some((line) => {
        const listener = /^n(?:127\.0\.0\.1|localhost|\[::1\]|\*|0\.0\.0\.0|\[::\]):(\d+)$/.exec(line);
        return listener?.[1] === port;
      });
      return ownsListener ? { webSocketUrl } : null;
    }

    // Only inspect Unix listeners explicitly requested by the Desktop child.
    // Stdio's anonymous socketpairs are not externally connectable endpoints.
    const sockets = await execute(
      "/usr/sbin/lsof", ["-nP", "-a", "-p", String(server.pid), "-U", "-Ftn"], commandOptions,
    );
    const requestedPath = server.listenUrl.slice("unix://".length);
    const socketPath = selectNamedUnixSocket(sockets.stdout, requestedPath);
    return socketPath ? { webSocketUrl: `ws+unix://localhost${encodeURI(socketPath)}:/rpc` } : null;
  } catch {
    // Discovery is optional. Missing tools, disappearing processes and
    // unsupported Desktop transports leave shared/standalone available.
    return null;
  }
}

function selectDesktopServer(stdout: string): DesktopServer | null {
  const processes = stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    return match ? [{ pid: Number(match[1]), parentPid: Number(match[2]), command: match[3]! }] : [];
  });
  const desktopPids = new Set(processes.filter(({ command }) =>
    /^\/.*\/(?:Codex|ChatGPT)\.app\/Contents\/MacOS\/(?:Codex|ChatGPT)(?:\s|$)/.test(command),
  ).map(({ pid }) => pid));

  for (const candidate of processes) {
    if (!desktopPids.has(candidate.parentPid)) continue;
    if (!/^(?:.*\/)?codex\s/.test(candidate.command)) continue;
    const appServerArgs = /\sapp-server(?:\s+(.*)|$)/.exec(candidate.command)?.[1];
    if (!appServerArgs || /^(?:proxy|daemon)(?:\s|$)|(?:^|\s)--managed-daemon(?:\s|$)/.test(appServerArgs)) continue;
    const listenUrl = /(?:^|\s)--listen(?:=|\s+)(unix:\/\/.*?|ws:\/\/\S+)(?=\s+-|$)/.exec(appServerArgs)?.[1];
    if (listenUrl) return { pid: candidate.pid, listenUrl };
  }
  return null;
}

function selectNamedUnixSocket(stdout: string, requestedPath: string): string | null {
  let unixSocket = false;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("t")) unixSocket = line === "tunix";
    if (!unixSocket || !line.startsWith("n/")) continue;
    const socketPath = line.slice(1).split(" type=")[0]!;
    if (socketPath.includes(" -> ") || socketPath.includes(":")) continue;
    if (requestedPath && requestedPath !== socketPath) continue;
    return socketPath;
  }
  return null;
}

function normalizeLocalEndpoint(value: string): string {
  const address = new URL(value);
  if (address.username || address.password || address.hash || address.search) {
    throw new Error("Codex Desktop endpoint must not contain credentials, a query or a fragment");
  }
  if (address.protocol === "ws+unix:") {
    if (address.hostname !== "localhost" || !/^\/.+:\/[^:]*$/.test(address.pathname)) {
      throw new Error("Codex Desktop endpoint must name an absolute local Unix socket and RPC path");
    }
    return address.href;
  }
  if (
    (address.protocol === "ws:" || address.protocol === "wss:")
    && ["localhost", "127.0.0.1", "[::1]"].includes(address.hostname)
  ) return address.href;
  throw new Error("Codex Desktop endpoint must be a local WebSocket or Unix socket");
}
