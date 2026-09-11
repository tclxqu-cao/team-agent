import { createServer, type Server } from "node:http";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createDesktopDiscovery } from "../../server/lib/desktop-discovery.mjs";
import { SharedServiceConnection, serviceApiUrl, validDescriptor } from "./shared-service";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "shared-service-"));
  closers.push(() => rm(root, { recursive: true, force: true }));
  const registry = join(root, "services");
  const start = async (name: string) => {
    const discovery = createDesktopDiscovery({ dataDir: join(root, name), directory: registry });
    const server = createServer((req, res) => { if (discovery.handle(req, res)) return; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ name })); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    await discovery.publish((server.address() as { port: number }).port);
    let stopped = false;
    const close = async () => { if (stopped) return; stopped = true; await discovery.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); };
    closers.push(close);
    return { server, close };
  };
  const client = new SharedServiceConnection(join(root, "selection.json"), registry);
  await client.initialize();
  return { root, client, start };
}
describe("desktop shared service", () => {
  it("discovers a real service, forwards JSON, and hides the credential", async () => {
    const { client, start } = await fixture(); await start("one");
    const status = await client.status();
    expect(status.connected).toBe(true); expect(JSON.stringify(status)).not.toContain('"token"');
    expect(JSON.parse((await client.json("/api/settings", "GET")).body)).toEqual({ name: "one" });
  });
  it("does not switch data sources after disconnect, but reconnects to the same data directory", async () => {
    const { client, start } = await fixture(); const first = await start("one"); await client.status();
    await start("two"); await first.close();
    expect((await client.status()).connected).toBe(false);
    await expect(client.json("/api/settings", "GET")).rejects.toThrow("未连接");
    await start("one"); expect((await client.status()).selected?.dataDir).toMatch(/one$/);
  });
  it("requires choosing between multiple services", async () => {
    const { client, start } = await fixture(); await start("one"); await start("two");
    const status = await client.status(); expect(status.connected).toBe(false);
    await client.select(status.choices[1].instanceId); expect((await client.status()).connected).toBe(true);
  });
  it("rejects non-loopback descriptors, redirects and API path escapes", () => {
    expect(validDescriptor({ protocol: 1, instanceId: "x", pid: 1, dataDir: "/data", token: "a".repeat(64), url: "http://example.com:3000" })).toBe(false);
    for (const path of ["https://evil.test/api/x", "//evil.test/api/x", "/api/../secret", "/api/\\evil"]) expect(() => serviceApiUrl("http://127.0.0.1:3001", path)).toThrow();
  });
});
