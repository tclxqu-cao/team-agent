import { lstat, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Credentials stay inside the infrastructure boundary and are never logged. */
export interface VSCodeAgentEndpoint {
  instanceId: string;
  pid: number;
  endpoint: { type: "socket"; path: string };
  connectionToken: string;
  protocolVersion: string;
}

export function vscodeUserDataDirectories(): string[] {
  if (process.env.AGENT_VSCODE_USER_DATA_DIR) return [process.env.AGENT_VSCODE_USER_DATA_DIR];
  const base = process.platform === "darwin" ? join(homedir(), "Library", "Application Support")
    : process.platform === "win32" ? process.env.APPDATA ?? join(homedir(), "AppData", "Roaming")
    : process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return [join(base, "Code"), join(base, "Code - Insiders")];
}

async function privateEntry(path: string, directory: boolean): Promise<boolean> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.size > 65_536)) return false;
  return process.platform === "win32" || (stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0);
}

/** Read only VS Code's owner-protected local endpoint catalogue; never starts a host. */
export async function discoverVSCodeAgentEndpoints(
  directories = vscodeUserDataDirectories(),
  isAlive: (pid: number) => boolean = pid => { try { process.kill(pid, 0); return true; } catch { return false; } },
): Promise<VSCodeAgentEndpoint[]> {
  const endpoints = new Map<string, VSCodeAgentEndpoint>();
  for (const directory of directories) {
    const entries = join(directory, "agent-host", "local-endpoint", "entries");
    try {
      if (!await privateEntry(entries, true)) continue;
      for (const name of await readdir(entries)) {
        if (!name.endsWith(".json")) continue;
        try {
          const path = join(entries, name);
          if (!await privateEntry(path, false)) continue;
          const value = JSON.parse(await readFile(path, "utf8"));
          if (value.schemaVersion !== 2 || value.type !== "editor" || !Number.isSafeInteger(value.pid)
            || value.pid <= 0 || !isAlive(value.pid) || typeof value.instanceId !== "string" || !value.instanceId
            || !/^1\.\d+\.\d+$/.test(value.protocolVersion) || value.endpoint?.type !== "socket"
            || typeof value.endpoint.path !== "string" || typeof value.connectionToken !== "string"
            || !value.connectionToken || value.connectionToken.length > 4096) continue;
          if (process.platform === "win32") {
            if (!value.endpoint.path.startsWith("\\\\.\\pipe\\vscode-agent-host-")) continue;
          } else {
            const socket = await lstat(value.endpoint.path);
            if (!socket.isSocket() || socket.uid !== process.getuid?.()) continue;
          }
          endpoints.set(value.instanceId, value);
        } catch { /* Stale, incomplete, or untrusted entries are not usable endpoints. */ }
      }
    } catch { /* VS Code may not be installed or running for this profile. */ }
  }
  return [...endpoints.values()];
}
