import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { lockInstanceStartup } from "./startup-lock.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function directory() {
  const path = await realpath(await mkdtemp(join(tmpdir(), "agentroam-startup-lock-")));
  temporary.push(path);
  return path;
}

it.skipIf(process.platform !== "win32")("recovers after the lock owner is forcibly terminated", async () => {
  const dataDir = await directory();
  const module = pathToFileURL(join(import.meta.dirname, "startup-lock.ts")).href;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e",
    `import { lockInstanceStartup } from ${JSON.stringify(module)}; await lockInstanceStartup(${JSON.stringify(dataDir)}); console.log('ready');`,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit");
  try {
    await Promise.race([once(child.stdout!, "data"), exited.then(() => { throw new Error("lock owner exited before readiness"); })]);
    await expect(lockInstanceStartup(dataDir.toUpperCase())).rejects.toThrow("正在启动");
    expect(await readFile(join(dataDir, ".cli-start.lock/pid"), "utf8")).toBe(String(child.pid));
    child.kill("SIGKILL"); await exited;
    const attempts = await Promise.allSettled([lockInstanceStartup(dataDir), lockInstanceStartup(dataDir)]);
    const acquired = attempts.filter((result): result is PromiseFulfilledResult<() => Promise<void>> => result.status === "fulfilled");
    try {
      expect(acquired).toHaveLength(1);
      expect(attempts.filter(result => result.status === "rejected")).toHaveLength(1);
      expect(await readFile(join(dataDir, ".cli-start.lock/pid"), "utf8")).toBe(String(process.pid));
    } finally { await Promise.all(acquired.map(result => result.value())); }
    await (await lockInstanceStartup(dataDir))();
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; } }
});

it.skipIf(process.platform !== "win32")("preserves a live legacy owner and releases the pipe on rejection", async () => {
  const dataDir = await directory();
  const path = join(dataDir, ".cli-start.lock");
  await mkdir(path);
  await writeFile(join(path, "pid"), String(process.pid));
  await expect(lockInstanceStartup(dataDir)).rejects.toThrow("正在启动");
  expect(await readFile(join(path, "pid"), "utf8")).toBe(String(process.pid));
  await rm(path, { recursive: true });
  const release = await lockInstanceStartup(dataDir);
  await Promise.all([release(), release()]);
  await (await lockInstanceStartup(dataDir))();
});
