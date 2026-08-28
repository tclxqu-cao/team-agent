import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { stopChildProcess } from "./child-process.js";
import type { TunnelHandle, TunnelProvider } from "./tunnel-provider.js";

type SpawnImpl = typeof spawn;

export class PinggyTunnelProvider implements TunnelProvider {
  constructor(
    private readonly port: number,
    private readonly dataDir: string,
    private readonly spawnImpl: SpawnImpl = spawn,
  ) {}

  async start({ signal, log }: { localUrl: string; signal: AbortSignal; log: (line: string) => void }): Promise<TunnelHandle> {
    const sshDir = resolve(this.dataDir, "ssh");
    await mkdir(sshDir, { recursive: true });
    const knownHosts = resolve(sshDir, "known_hosts");
    const args = [
      "-p", "443",
      "-o", "ExitOnForwardFailure=yes",
      "-o", "ServerAliveInterval=30",
      "-o", "ServerAliveCountMax=3",
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", `UserKnownHostsFile=${knownHosts}`,
      "-R", `0:localhost:${this.port}`,
      "free.pinggy.io",
    ];
    const child = this.spawnImpl("ssh", args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    const abort = () => void stopChildProcess(child);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();

    try {
      const publicUrl = await waitForPinggyUrl(child, log, 30_000);
      const exited = new Promise<{ code: number | null; signal: string | null }>((resolvePromise) =>
        child.once("exit", (code, childSignal) => resolvePromise({ code, signal: childSignal })),
      );
      return { publicUrl, exited, close: () => stopChildProcess(child) };
    } catch (error) {
      await stopChildProcess(child);
      throw error;
    }
  }
}

export function parsePinggyUrl(text: string): string | null {
  return text.match(/https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.pinggy-free\.link/i)?.[0] ?? null;
}

function waitForPinggyUrl(child: ChildProcess, log: (line: string) => void, timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let buffer = "";
    let settled = false;
    const finish = (error?: Error, url?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolvePromise(url!);
    };
    const timer = setTimeout(() => finish(new Error("Pinggy tunnel URL timeout")), timeoutMs);
    const read = (chunk: Buffer) => {
      const text = chunk.toString();
      buffer = (buffer + text).slice(-16_384);
      for (const line of text.split(/\r?\n/)) if (line) log(redact(line));
      const url = parsePinggyUrl(buffer);
      if (url) finish(undefined, url);
    };
    child.stdout?.on("data", read);
    child.stderr?.on("data", read);
    child.once("error", (error) => finish(error));
    child.once("exit", (code) => finish(new Error(`Pinggy SSH exited before URL (${code})`)));
  });
}

function redact(text: string): string {
  return text.replace(/pair=[^\s&]+/g, "pair=[REDACTED]");
}
