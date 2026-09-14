import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockInstanceStartup, stopPreviousInstances } from "./instance-takeover.js";
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cli-takeover-"))); temporary.push(root);
  const registry = join(root, "registry"); const dataDir = join(root, "data-dir");
  await mkdir(registry); await mkdir(join(dataDir, "data"), { recursive: true });
  const descriptor = { protocol: 1, instanceId: "test-instance", pid: 200, url: "http://127.0.0.1:12345", dataDir: join(dataDir, "data"), token: "a".repeat(64) };
  const save = () => writeFile(join(registry, "test.json"), JSON.stringify(descriptor)); await save();
  const rows = [{ pid: 200, ppid: 100, command: "/node /runtime/ws-server.mjs" }, { pid: 100, ppid: 1, command: "/node /cache/node_modules/agentroam/bin/agentroam.mjs" }];
  const stop = vi.fn(async () => {});
  const deps = { registry, request: vi.fn(async () => Response.json(descriptor)) as unknown as typeof fetch, processes: vi.fn(async () => rows), stop, alive: () => false, timeoutMs: 1 };
  return { descriptor, save, deps, stop, dataDir, rows };
}
it("authenticates the same data directory and stops the CLI parent before proceeding", async () => {
  const f = await fixture(); await stopPreviousInstances(f.dataDir, () => {}, f.deps);
  expect(f.stop).toHaveBeenCalledTimes(1); expect(f.stop).toHaveBeenCalledWith(100);
  expect(f.deps.processes).toHaveBeenCalledTimes(2);
});
it("leaves a different data directory untouched without making an authenticated request", async () => {
  const f = await fixture(); f.descriptor.dataDir = tmpdir(); await f.save();
  await stopPreviousInstances(f.dataDir, () => {}, f.deps);
  expect(f.deps.request).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled();
});
it("does not send the private token to non-loopback addresses", async () => {
  const f = await fixture(); f.descriptor.url = "https://example.com"; await f.save();
  await stopPreviousInstances(f.dataDir, () => {}, f.deps);
  expect(f.deps.request).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled();
});
it("rejects a matching live server with a non-CLI parent", async () => {
  const f = await fixture(); f.rows[1].command = "/Applications/Other.app/server";
  await expect(stopPreviousInstances(f.dataDir, () => {}, f.deps)).rejects.toThrow("无法确认"); expect(f.stop).not.toHaveBeenCalled();
});
it("does not signal a reused PID", async () => {
  const f = await fixture(); f.deps.processes.mockResolvedValueOnce(f.rows).mockResolvedValueOnce([{ ...f.rows[0], ppid: 300 }, f.rows[1]]);
  await expect(stopPreviousInstances(f.dataDir, () => {}, f.deps)).rejects.toThrow("身份已变化"); expect(f.stop).not.toHaveBeenCalled();
});
it("refuses to launch while the previous process still runs", async () => {
  const f = await fixture(); f.deps.alive = () => true;
  await expect(stopPreviousInstances(f.dataDir, () => {}, f.deps)).rejects.toThrow("尚未退出");
});
it("ignores stale dead descriptors but blocks unreachable live instances", async () => {
  const f = await fixture(); f.deps.request = vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  await stopPreviousInstances(f.dataDir, () => {}, f.deps); expect(f.stop).not.toHaveBeenCalled();
  f.deps.alive = () => true;
  await expect(stopPreviousInstances(f.dataDir, () => {}, f.deps)).rejects.toThrow("无法核验");
});
it("serializes startup and releases the lock for the next launch", async () => {
  const f = await fixture(); const release = await lockInstanceStartup(f.dataDir);
  await expect(lockInstanceStartup(f.dataDir)).rejects.toThrow("正在启动");
  await release(); await release(); await (await lockInstanceStartup(f.dataDir))();
});

it.skipIf(process.platform === "win32")("stops an authenticated real CLI parent and waits for its server child to exit", async () => {
  const { spawn } = await import("node:child_process");
  const f = await fixture();
  const cli = join(f.dataDir, "node_modules/agentroam/bin/agentroam.mjs");
  const server = join(f.dataDir, "runtime/ws-server.mjs");
  await mkdir(join(f.dataDir, "node_modules/agentroam/bin"), { recursive: true });
  await mkdir(join(f.dataDir, "runtime"));
  await writeFile(server, `import http from 'node:http';\nimport {writeFileSync} from 'node:fs';\nconst d=JSON.parse(process.env.DESCRIPTOR);d.pid=process.pid;\nconst s=http.createServer((req,res)=>{if(req.headers['x-agentroam-desktop-token']!==d.token){res.writeHead(401).end();return;}res.setHeader('content-type','application/json');res.end(JSON.stringify(d));});\ns.listen(0,'127.0.0.1',()=>{d.url='http://127.0.0.1:'+s.address().port;writeFileSync(process.env.RECORD,JSON.stringify(d));console.log('ready');});`);
  await writeFile(cli, `import {spawn} from 'node:child_process';\nimport {writeFileSync} from 'node:fs';\nconst child=spawn(process.execPath,[process.env.SERVER],{stdio:['ignore','inherit','inherit']});\nprocess.on('SIGTERM',()=>{writeFileSync(process.env.MARKER,'graceful');child.kill('SIGTERM');});\nchild.on('exit',()=>process.exit(0));`);
  const marker = join(f.dataDir, "stopped");
  const child = spawn(process.execPath, [cli], { env: { ...process.env, SERVER: server, RECORD: join(f.deps.registry, "test.json"), DESCRIPTOR: JSON.stringify(f.descriptor), MARKER: marker }, stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit");
  try {
    await once(child.stdout!, "data");
    await stopPreviousInstances(f.dataDir, () => {}, { registry: f.deps.registry, stop: async pid => { expect(pid).toBe(child.pid); process.kill(pid, "SIGTERM"); } });
    await exited;
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(marker, "utf8")).toBe("graceful");
  } finally { if (child.exitCode === null) { child.kill("SIGTERM"); await exited; } }
});

it("stops an authenticated orphan only when its executable belongs to a runtime package", async () => {
  const f = await fixture();
  const pkg = join(f.dataDir, "launcher/0.2.0-preview.18/node_modules/agentroam-runtime-darwin-arm64");
  await mkdir(join(pkg, "runtime"), { recursive: true });
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "agentroam-runtime-darwin-arm64" }));
  await writeFile(join(pkg, "runtime/ws-server.mjs"), "// fixture");
  f.rows.splice(0, f.rows.length, { pid: 200, ppid: 1, command: `/node ${join(pkg, "runtime/ws-server.mjs")}` });
  await stopPreviousInstances(f.dataDir, () => {}, f.deps);
  expect(f.stop).toHaveBeenCalledWith(200);
});
it("does not stop an orphan merely because its script is named ws-server.mjs", async () => {
  const f = await fixture(); f.rows.splice(0, f.rows.length, { pid: 200, ppid: 1, command: "/node /unrelated/ws-server.mjs" });
  await expect(stopPreviousInstances(f.dataDir, () => {}, f.deps)).rejects.toThrow("无法确认");
  expect(f.stop).not.toHaveBeenCalled();
});
