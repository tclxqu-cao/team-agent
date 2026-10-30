import { execFile } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type DiscoveryExecutor = (
  command: string,
  args: string[],
  options: { encoding: "utf8"; timeout: number; maxBuffer: number },
) => Promise<{ stdout: string }>;

interface Options {
  configDir: string;
  platform?: NodeJS.Platform;
  execute?: DiscoveryExecutor;
}

/** Borrow the configuration published by the running desktop daemon, never its bootstrap catalog. */
export async function discoverWorkBuddyDesktopProductConfig(options: Options): Promise<string | null> {
  if ((options.platform ?? process.platform) !== "darwin") return null;
  try {
    const execute = options.execute ?? execFileAsync as DiscoveryExecutor;
    const { stdout } = await execute("/bin/ps", ["-axo", "pid=,ppid=,args="], {
      encoding: "utf8", timeout: 1_500, maxBuffer: 2 * 1024 * 1024,
    });
    const processes = stdout.split("\n").flatMap(line => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      return match ? [{ pid: Number(match[1]), parentPid: Number(match[2]), command: match[3]! }] : [];
    });
    const desktops = new Map(processes.flatMap(process => {
      const match = /^(\/.*\/WorkBuddy(?: AI)?\.app\/Contents\/MacOS\/Electron)(?:\s|$)/.exec(process.command);
      return match && !/daemon-app-server-entry\.[cm]?js/.test(process.command) ? [[process.pid, match[1]!] as const] : [];
    }));
    const daemonPids = new Set(processes.filter(process => {
      const desktop = desktops.get(process.parentPid);
      return desktop && process.command.startsWith(`${desktop} `)
        && /[\\/]app\.asar[\\/]main[\\/]daemon-app-server-entry\.[cm]?js\s+--stdio(?:\s|$)/.test(process.command);
    }).map(process => process.pid));
    if (!daemonPids.size) return null;

    const cache = join(options.configDir, "cache");
    const candidates = await Promise.all((await readdir(cache)).map(async name => {
      const match = /^acc-product-config-v3-(\d+)-[0-9a-f-]+\.json$/.exec(name);
      if (!match || !daemonPids.has(Number(match[1]))) return null;
      try {
        const path = join(cache, name);
        const info = await lstat(path);
        if (!info.isFile() || info.size > 16 * 1024 * 1024) return null;
        if (typeof process.getuid === "function" && info.uid !== process.getuid()) return null;
        const config: unknown = JSON.parse(await readFile(path, "utf8"));
        if (!config || typeof config !== "object" || Array.isArray(config)) return null;
        const { agents, models } = config as Record<string, unknown>;
        if (!Array.isArray(models) || !models.length || !Array.isArray(agents)) return null;
        if (!agents.some(agent => agent && Array.isArray(agent.tags) && agent.tags.includes("default")
          && Array.isArray(agent.models) && agent.models.length)) return null;
        return { path, modified: info.mtimeMs };
      } catch { return null; }
    }));
    return candidates.filter(candidate => candidate !== null)
      .sort((left, right) => right.modified - left.modified)[0]?.path ?? null;
  } catch {
    // Missing desktop, unavailable discovery and a configuration being replaced are retriable.
    return null;
  }
}
