import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { TunnelController, attachTunnelControl } from "./tunnel-controller.js";
import { parseArgs } from "../args.js";
import { ServiceRuntimeReporter } from "../service/runtime-state.js";
import { resolveServicePaths } from "../service/service-files.js";

const closers: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });

it("changes only the tunnel over real Node IPC while the server and its running task survive", async () => {
  const root = await mkdtemp(join(tmpdir(), "tunnel-ipc-"));
  closers.push(() => rm(root, { recursive: true, force: true }));
  const discovery = new URL("../../../server/lib/desktop-discovery.mjs", import.meta.url).href;
  const gateway = new URL("../../../server/lib/tunnel-control.mjs", import.meta.url).href;
  const source = `
    import { createServer } from 'node:http';
    import { spawn } from 'node:child_process';
    import { createDesktopDiscovery } from ${JSON.stringify(discovery)};
    import { createTunnelControlGateway } from ${JSON.stringify(gateway)};
    const task = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    const desktop = createDesktopDiscovery({dataDir: ${JSON.stringify(root)}, directory: ${JSON.stringify(join(root, "registry"))}});
    const control = createTunnelControlGateway({desktop});
    let requests = 0;
    const server = createServer((req, res) => {
      if (desktop.handle(req, res) || control.handle(req, res)) return;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({pid: process.pid, taskPid: task.pid, requests: ++requests, taskRunning: task.exitCode === null}));
    });
    server.listen(0, '127.0.0.1', async () => {
      await desktop.publish(server.address().port);
      process.send({type:'test:ready', port:server.address().port, headers:desktop.headers()});
    });
    process.on('message', async message => {
      if (message.type !== 'test:stop') return;
      task.kill(); control.close(); await desktop.close(); server.closeAllConnections(); server.close(() => process.exit());
    });
    process.on('disconnect', () => { task.kill(); process.exit(); });
  `;
  const child: ChildProcess = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
  let stderr = ""; child.stderr!.on("data", chunk => { stderr += chunk; });
  closers.push(async () => {
    if (child.exitCode !== null) return;
    const ended = once(child, "exit");
    child.send({ type: "test:stop" });
    await ended;
  });
  const ready = await Promise.race([
    once(child, "message").then(([value]) => value as { port: number; headers: Record<string, string> }),
    once(child, "exit").then(() => { throw new Error(stderr || "Test service exited"); }),
  ]);
  const base = `http://127.0.0.1:${ready.port}`;
  const snapshot = () => fetch(`${base}/task`).then(response => response.json());
  const before = await snapshot();
  const paths = resolveServicePaths(root, root);
  const reporter = new ServiceRuntimeReporter(paths, "test");
  let end!: () => void;
  const handle = { publicUrl: "https://working.example", close: vi.fn(async () => {}), exited: new Promise<{ code: number | null; signal: string | null }>(resolve => { end = () => resolve({ code: 1, signal: null }); }) };
  const controller = new TunnelController({
    relay: { cli: parseArgs(["--local-only"]), target: "windows-amd64", localUrl: base, port: ready.port, log: vi.fn(),
      readiness: async () => {}, providerFactories: { cloudflare: async () => ({ start: async () => handle }) } },
    lanUrl: async () => `http://192.168.1.10:${ready.port}`,
    publish: async status => { await reporter.ready({ localUrl: base, publicUrl: new URL(status.accessUrl!).origin, accessUrl: status.accessUrl!, provider: status.provider }); },
  });
  const detach = attachTunnelControl(child, controller);
  closers.push(async () => { detach(); await controller.close(); });
  await controller.connect(false);
  const status = () => fetch(`${base}/api/desktop/tunnel`, { headers: ready.headers }).then(response => response.json());
  await vi.waitFor(async () => expect(await status()).toMatchObject({ phase: "idle", mode: "lan" }));
  expect((await fetch(`${base}/api/desktop/tunnel/connect`, { method: "POST", headers: ready.headers })).status).toBe(202);
  await vi.waitFor(async () => expect(await status()).toMatchObject({ phase: "ready", mode: "public" }));
  expect((await readFile(paths.urlPath, "utf8")).trim()).toBe("https://working.example/web");
  const after = await snapshot();
  expect(after).toMatchObject({ pid: before.pid, taskPid: before.taskPid, taskRunning: true, requests: before.requests + 1 });
  end();
  await vi.waitFor(async () => expect(await status()).toMatchObject({ phase: "error", mode: "lan" }));
  expect((await readFile(paths.urlPath, "utf8")).trim()).toBe(`http://192.168.1.10:${ready.port}/web`);
  expect(await snapshot()).toMatchObject({ pid: before.pid, taskPid: before.taskPid, taskRunning: true });
}, 15_000);
