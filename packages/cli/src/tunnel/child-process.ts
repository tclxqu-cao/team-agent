import type { ChildProcess } from "node:child_process";

export async function stopChildProcess(child: ChildProcess, timeoutMs = 3_000): Promise<void> {
  if (child.exitCode !== null || !child.pid) return;
  const exited = new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
  signal(child, "SIGTERM");
  await Promise.race([exited, new Promise<void>((resolvePromise) => setTimeout(resolvePromise, timeoutMs))]);
  if (child.exitCode === null) signal(child, "SIGKILL");
}

function signal(child: ChildProcess, name: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, name);
    else child.kill(name);
  } catch {
    try {
      child.kill(name);
    } catch {}
  }
}
