import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ProxyResolverOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  readMacSystemProxy?: () => Promise<string>;
}

export interface SystemProxySettings {
  httpProxy: string | null;
  httpsProxy: string | null;
}

export async function resolveProxyForUrl(
  target: URL,
  options: ProxyResolverOptions = {},
): Promise<string | null> {
  const env = options.env ?? process.env;
  const noProxy = env.no_proxy?.trim() ? env.no_proxy : env.NO_PROXY;
  if (matchesNoProxy(target, noProxy)) return null;

  const environmentProxy = selectEnvironmentProxy(target.protocol, env);
  if (environmentProxy !== null) return normalizeProxyUrl(environmentProxy);

  if ((options.platform ?? process.platform) !== "darwin") return null;

  try {
    const output = await (options.readMacSystemProxy ?? readMacSystemProxy)();
    const settings = parseMacSystemProxy(output);
    if (target.protocol === "https:") return settings.httpsProxy ?? settings.httpProxy;
    if (target.protocol === "http:") return settings.httpProxy;
  } catch {
    // Proxy discovery is best-effort; direct readiness retains the previous behavior.
  }
  return null;
}

export function parseMacSystemProxy(output: string): SystemProxySettings {
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z][A-Za-z0-9]*)\s*:\s*(.*?)\s*$/.exec(line);
    if (match) values.set(match[1], match[2]);
  }

  return {
    httpProxy: buildMacProxy(values, "HTTP"),
    httpsProxy: buildMacProxy(values, "HTTPS"),
  };
}

async function readMacSystemProxy(): Promise<string> {
  const { stdout } = await execFileAsync("/usr/sbin/scutil", ["--proxy"], {
    encoding: "utf8",
    timeout: 2_000,
  });
  return stdout;
}

function selectEnvironmentProxy(protocol: string, env: NodeJS.ProcessEnv): string | null {
  const candidates =
    protocol === "https:"
      ? [env.https_proxy, env.HTTPS_PROXY, env.http_proxy, env.HTTP_PROXY, env.all_proxy, env.ALL_PROXY]
      : protocol === "http:"
        ? [env.http_proxy, env.HTTP_PROXY, env.all_proxy, env.ALL_PROXY]
        : [env.all_proxy, env.ALL_PROXY];

  for (const candidate of candidates) {
    if (candidate !== undefined && candidate.trim() !== "") return candidate;
  }
  return null;
}

function normalizeProxyUrl(value: string): string | null {
  const candidate = value.trim();
  try {
    const proxy = new URL(candidate.includes("://") ? candidate : `http://${candidate}`);
    if (!(["http:", "https:"] as string[]).includes(proxy.protocol) || proxy.hostname === "") return null;
    return proxy.toString();
  } catch {
    return null;
  }
}

function buildMacProxy(values: Map<string, string>, prefix: "HTTP" | "HTTPS"): string | null {
  if (values.get(`${prefix}Enable`) !== "1") return null;

  const host = values.get(`${prefix}Proxy`)?.trim();
  const portText = values.get(`${prefix}Port`)?.trim();
  const port = portText === undefined ? Number.NaN : Number(portText);
  if (!host || /[\s\/?#@]/.test(host) || !Number.isInteger(port) || port < 1 || port > 65_535) return null;

  const formattedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return normalizeProxyUrl(`http://${formattedHost}:${port}`);
}

function matchesNoProxy(target: URL, value: string | undefined): boolean {
  if (!value) return false;

  const hostname = normalizeHostname(target.hostname);
  const targetPort = target.port || defaultPort(target.protocol);

  for (const entry of value.split(",")) {
    const rule = parseNoProxyRule(entry);
    if (!rule) continue;
    if (rule.host === "*") return true;
    if (rule.port !== null && rule.port !== targetPort) continue;
    if (hostname === rule.host || hostname.endsWith(`.${rule.host}`)) return true;
  }
  return false;
}

function parseNoProxyRule(entry: string): { host: string; port: string | null } | null {
  let value = entry.trim().toLowerCase();
  if (!value) return null;
  if (value === "*") return { host: "*", port: null };

  let host = value;
  let port: string | null = null;
  if (value.startsWith("[")) {
    const closingBracket = value.indexOf("]");
    if (closingBracket < 0) return null;
    host = value.slice(1, closingBracket);
    const remainder = value.slice(closingBracket + 1);
    if (remainder) {
      if (!/^:\d+$/.test(remainder)) return null;
      port = remainder.slice(1);
    }
  } else {
    const colon = value.lastIndexOf(":");
    if (colon >= 0 && value.indexOf(":") === colon) {
      const possiblePort = value.slice(colon + 1);
      if (/^\d+$/.test(possiblePort)) {
        host = value.slice(0, colon);
        port = possiblePort;
      }
    }
  }

  host = normalizeHostname(host.replace(/^\*?\./, ""));
  return host ? { host, port } : null;
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function defaultPort(protocol: string): string {
  if (protocol === "https:") return "443";
  if (protocol === "http:") return "80";
  return "";
}
