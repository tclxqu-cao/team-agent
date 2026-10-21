import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** Serialize startup within a data directory; never remove a live owner's lock. */
export async function lockInstanceStartup(dataDir: string): Promise<() => Promise<void>> {
  await mkdir(dataDir, { recursive: true });
  const path = resolve(await realpath(dataDir), ".cli-start.lock");
  // Task Scheduler can terminate the CLI without running finally. A named pipe
  // is released by Windows even on forced termination; retain the PID marker
  // so older launchers still see an in-progress startup.
  let closePipe: (() => Promise<void>) | undefined;
  const busy = () => new Error("此数据目录已有 CLI 正在启动；请等它完成后重试。");
  if (process.platform === "win32") {
    const pipe = createServer();
    const name = createHash("sha256").update(path.toLowerCase()).digest("hex");
    await new Promise<void>((done, reject) => {
      const onError = (error: NodeJS.ErrnoException) => reject(error.code === "EADDRINUSE" ? busy() : error);
      pipe.once("error", onError);
      pipe.listen(`\\\\.\\pipe\\agentroam-startup-${name}`, () => { pipe.removeListener("error", onError); done(); });
    });
    closePipe = () => new Promise<void>((done, reject) => pipe.close(error => error ? reject(error) : done()));
    try {
      const owner = (await readFile(join(path, "pid"), "utf8").catch(error => {
        if (error.code === "ENOENT") return null;
        throw error;
      }))?.trim();
      if (owner !== undefined && owner !== null) {
        const pid = Number(owner);
        // Be conservative with corrupt markers and potentially reused live PIDs.
        if (!Number.isSafeInteger(pid) || pid <= 1 || alive(pid)) throw busy();
        await rm(path, { recursive: true, force: true });
      }
    } catch (error) { await closePipe(); throw error; }
  }
  try {
    try { await mkdir(path, { mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      throw new Error("此数据目录已有 CLI 正在启动；请等它完成后重试。若上次异常退出，请确认无启动进程后移除 .cli-start.lock。");
    }
    try { await writeFile(join(path, "pid"), String(process.pid), { mode: 0o600 }); }
    catch (error) { await rm(path, { recursive: true, force: true }); throw error; }
    let release: Promise<void> | undefined;
    return () => release ??= (async () => {
      try { await rm(path, { recursive: true, force: true }); }
      finally { await closePipe?.(); }
    })();
  } catch (error) { await closePipe?.(); throw error; }
}
