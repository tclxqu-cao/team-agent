import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startDetachedNativeRuntimeHost } from "./detached-native-runtime-host";
import { NativeRuntimeBrokerClient } from "./native-runtime-broker";
import { encodeUnifiedSessionId } from "./session-id";

const distribution = pathToFileURL(resolve(import.meta.dirname, "../../dist/index.js")).href;
const sessionId = encodeUnifiedSessionId("zcode", "detached-host-test");
const directories: string[] = [];
const children: ChildProcess[] = [];
const hosts = new Set<number>();

async function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => child.once("exit", () => resolve()));
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited(child);
  }
  for (const directory of directories) {
    const pidFile = join(directory, "host.pid");
    if (existsSync(pidFile)) hosts.add(Number(await readFile(pidFile, "utf8")));
    const logFile = join(directory, "native-runtime-host.log");
    if (existsSync(logFile)) {
      for (const line of (await readFile(logFile, "utf8")).split("\n")) {
        try {
          const entry = JSON.parse(line);
          if (entry.event === "native-runtime-host.started") hosts.add(entry.pid);
        } catch { /* Bootstrap errors also write plain stack traces. */ }
      }
    }
  }
  for (const pid of hosts) {
    if (Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid) {
      try { process.kill(pid, "SIGTERM"); } catch { /* The owned fixture already stopped. */ }
    }
  }
  hosts.clear();
  await delay(100);
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function fixture(): Promise<{ directory: string; moduleUrl: string }> {
  const directory = await mkdtemp(join(tmpdir(), "agentroam-detached-"));
  directories.push(directory);
  const modulePath = join(directory, "runtime-fixture.mjs");
  await writeFile(modulePath, `
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
export { NativeRuntimeBrokerHost } from ${JSON.stringify(distribution)};
export function createNativeRuntimeBrokerHostRuntime() {
  const { directory } = JSON.parse(process.argv[1]);
  const summary = { id: ${JSON.stringify(sessionId)}, agentType: "zcode", nativeSessionId: "detached-host-test",
    title: "Detached fixture", cwd: directory, status: "idle", occupancy: "available", canResume: true };
  return {
    health: async () => [{ agentType: "zcode", available: true, label: "Fixture" }],
    getRunSummary: async () => summary,
    invalidate() {},
    dispose: async () => {},
    run: async function* () {
      yield { type: "thinking" };
      yield { type: "text_chunk", text: "started" };
      while (!existsSync(join(directory, "finish"))) await delay(20);
      yield { type: "done", finalText: "survived client exit" };
    },
  };
}
`);
  return { directory, moduleUrl: pathToFileURL(modulePath).href };
}

describe("independent native host process", () => {
  it("coalesces competing process startups around one live socket", async () => {
    const config = await fixture();
    const pids = await Promise.all([startDetachedNativeRuntimeHost(config), startDetachedNativeRuntimeHost(config)])
      .catch(async error => { throw new Error(String(error) + "\n" + await readFile(join(config.directory, "native-runtime-host.log"), "utf8")); });
    pids.forEach(pid => hosts.add(pid));
    expect(new Set(pids).size).toBe(1);
    await expect(startDetachedNativeRuntimeHost(config)).resolves.toBe(pids[0]);
  });

  it("recovers a startup lock whose owner no longer exists", async () => {
    const config = await fixture();
    await writeFile(join(config.directory, "native-runtime-start.lock"), "99999999");
    const pid = await startDetachedNativeRuntimeHost(config);
    hosts.add(pid);
    expect(pid).toBeGreaterThan(0);
    expect(existsSync(join(config.directory, "native-runtime-start.lock"))).toBe(false);
  });

  it("finishes the same admitted run after its client process exits and a new client reconnects", async () => {
    const config = await fixture();
    const worker = spawn(process.execPath, ["--input-type=module", "--eval", `
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { NativeRuntimeBrokerClient, startDetachedNativeRuntimeHost } from ${JSON.stringify(distribution)};
const config = ${JSON.stringify(config)};
const client = new NativeRuntimeBrokerClient({ directory: config.directory, startHost: async directory => {
  const pid = await startDetachedNativeRuntimeHost({ ...config, directory });
  writeFileSync(join(directory, "host.pid"), String(pid));
}});
for await (const event of client.run(${JSON.stringify(sessionId)}, "one accepted input")) console.log(JSON.stringify(event));
`], { stdio: ["ignore", "pipe", "pipe"] });
    children.push(worker);
    let output = "";
    let errors = "";
    worker.stdout!.on("data", chunk => { output += chunk; });
    worker.stderr!.on("data", chunk => { errors += chunk; });
    await vi.waitFor(() => expect(output, errors).toContain("started"), { timeout: 8_000 });
    const hostPid = Number(await readFile(join(config.directory, "host.pid"), "utf8"));
    hosts.add(hostPid);
    expect(hostPid).not.toBe(worker.pid);

    const replacement = new NativeRuntimeBrokerClient({ directory: config.directory });
    const before = await replacement.snapshot(sessionId);
    expect(before.runId).toBeTruthy();
    worker.kill("SIGTERM");
    await exited(worker);
    expect(() => process.kill(hostPid, 0)).not.toThrow();

    // A losing startup contender must neither interrupt nor recover the live run.
    await expect(startDetachedNativeRuntimeHost(config)).resolves.toBe(hostPid);
    await writeFile(join(config.directory, "finish"), "finish");
    await vi.waitFor(async () => {
      const after = await replacement.snapshot(sessionId);
      expect(after.runId).toBe(before.runId);
      expect(after.events.filter(item => item.event.type === "done")).toHaveLength(1);
      expect(after.events.some(item => item.event.type === "error")).toBe(false);
    }, { timeout: 4_000 });
  }, 15_000);

  it("reports a failed bootstrap with its log path", async () => {
    const config = await fixture();
    await expect(startDetachedNativeRuntimeHost({ ...config, moduleUrl: "file:///missing-native-runtime-entry.mjs", timeoutMs: 1_000 }))
      .rejects.toThrow("native-runtime-host.log");
    expect(await readFile(join(config.directory, "native-runtime-host.log"), "utf8"))
      .toContain("ERR_MODULE_NOT_FOUND");
  });
});
