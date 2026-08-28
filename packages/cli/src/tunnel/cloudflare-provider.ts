import { spawn, type ChildProcess } from "node:child_process";
import { stopChildProcess } from "./child-process.js";
import type { TunnelHandle, TunnelProvider } from "./tunnel-provider.js";

export class CloudflareTunnelProvider implements TunnelProvider {
  constructor(private readonly executable: string) {}

  async start({ localUrl, signal, log }: { localUrl: string; signal: AbortSignal; log: (line: string) => void }): Promise<TunnelHandle> {
    const child = spawn(this.executable, ["tunnel", "--no-autoupdate", "--url", localUrl], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    const abort = () => void stopChildProcess(child);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try {
      const publicUrl = await waitForConnectedUrl(child, log, 30_000);
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

export function waitForConnectedUrl(
  child: ChildProcess,
  log: (line: string) => void,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const buffers = { stdout: "", stderr: "" };
    let publicUrl: string | null = null;
    let connected = false;
    let settled = false;
    const finish = (error?: Error, url?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolvePromise(url!);
    };
    const timer = setTimeout(() => finish(new Error("cloudflared tunnel connection timeout")), timeoutMs);
    const read = (stream: keyof typeof buffers) => (chunk: Buffer) => {
      const text = chunk.toString();
      const buffer = (buffers[stream] + text).slice(-8192);
      buffers[stream] = buffer;
      for (const line of text.split(/\r?\n/)) if (line) log(line.replace(/pair=[^\s&]+/g, "pair=[REDACTED]"));
      const match = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (match) publicUrl = match[0];
      if (/Registered tunnel connection/i.test(buffer)) connected = true;
      if (publicUrl && connected) finish(undefined, publicUrl);
    };
    child.stdout?.on("data", read("stdout"));
    child.stderr?.on("data", read("stderr"));
    child.once("exit", (code) => finish(new Error(`cloudflared exited before tunnel became ready (${code})`)));
    child.once("error", (error) => finish(error));
  });
}
