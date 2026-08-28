import { spawn, type ChildProcess } from "node:child_process";
import { stopChildProcess } from "./child-process.js";
import type { TunnelHandle, TunnelProvider } from "./tunnel-provider.js";

export class CustomCommandTunnelProvider implements TunnelProvider {
  constructor(private readonly command: string, private readonly port: number) {}

  async start({ signal, log }: { localUrl: string; signal: AbortSignal; log: (line: string) => void }): Promise<TunnelHandle> {
    const rendered = this.command.replaceAll("{port}", String(this.port));
    const child = spawn(rendered, {
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    const abort = () => void stopChildProcess(child);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try {
      const publicUrl = await waitForCustomUrl(child, log, 30_000);
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

function waitForCustomUrl(child: ChildProcess, log: (line: string) => void, timeoutMs: number): Promise<string> {
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
    const timer = setTimeout(() => finish(new Error("custom tunnel URL timeout")), timeoutMs);
    const read = (chunk: Buffer) => {
      const text = chunk.toString();
      buffer = (buffer + text).slice(-8192);
      for (const line of text.split(/\r?\n/)) if (line) log(line.replace(/pair=[^\s&]+/g, "pair=[REDACTED]"));
      const match = buffer.match(/https:\/\/[^\s]+/i);
      if (match) finish(undefined, match[0].replace(/[),.;]+$/, ""));
    };
    child.stdout?.on("data", read);
    child.stderr?.on("data", read);
    child.once("error", (error) => finish(error));
    child.once("exit", (code) => finish(new Error(`custom tunnel exited before URL (${code})`)));
  });
}
