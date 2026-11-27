import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, writeFile, rm, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZCodeDesktopBridge } from "./zcode-desktop-bridge.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(close => close())); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "agentroam-guide-"));
  const calls: Array<{ method: string; params: Record<string, any>; target: Record<string, string> }> = [];
  const receipts = new Map<string, unknown>();
  let active = true;
  let loseAck = false;
  const hostId = "11223344-1122-3344-5566-112233445566";
  const token = "a".repeat(64);
  const server: Server = createServer(async (request, response) => {
    expect(request.headers.authorization).toBe(`Bearer ${token}`);
    let text = ""; for await (const chunk of request) text += chunk;
    const packet = JSON.parse(text); calls.push(packet);
    expect(packet.hostId).toBe(hostId);
    let result: unknown;
    if (packet.method === "probe") result = { supported: active && packet.target.sessionId === "sess", hostId };
    else if (packet.method === "read") result = { session: { sessionId: "sess" }, messages: [] };
    else if (packet.method === "v4/commands/query") result = { results: packet.params.commands.map((key: { commandId: string }) => ({ key, result: receipts.get(key.commandId) ?? "unknown" })) };
    else {
      const command = packet.params;
      result = receipts.get(command.commandId) ?? { commandId: command.commandId, status: "accepted", result: { type: "inputAccepted", inputId: command.commandId, delivery: "guide" } };
      receipts.set(command.commandId, result);
      if (loseAck) { loseAck = false; response.destroy(); return; }
    }
    response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ result }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const descriptor = join(directory, `${process.pid}-${hostId}.json`);
  await writeFile(descriptor, JSON.stringify({ version: 1, protocol: "zcode-desktop-guide", hostId, pid: process.pid, port, token }), { mode: 0o600 });
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
  return { directory, descriptor, calls, receipts, client: new ZCodeDesktopBridge({ directory }),
    end: () => { active = false; }, loseAck: () => { loseAck = true; } };
}
const session = { id: "sess", cwd: "/fixture" };

describe("ZCode desktop guide owner transport", () => {
  it("discovers a live owner, retains workspace identity and submits one native guide", async () => {
    const f = await fixture();
    expect(await f.client.available(session)).toBe(true);
    const target = { ...session, workspaceIdentity: "remote:fixture" };
    await expect(f.client.steer(target, "extra", "message-one")).resolves.toBe(true);
    await expect(f.client.steer(target, "extra", "message-one")).resolves.toBe(true);
    expect(f.calls.filter(call => call.method === "v4/command")).toHaveLength(1);
    expect(f.calls.find(call => call.method === "v4/command")?.target.workspaceIdentity).toBe("remote:fixture");
    expect(f.calls.some(call => /session\/(resume|send|create)/.test(call.method))).toBe(false);
  });

  it("queries the same command when the owner accepted input but the ACK was lost", async () => {
    const f = await fixture(); f.loseAck();
    await expect(f.client.steer(session, "extra", "message-one")).resolves.toBe(true);
    expect(f.calls.filter(call => call.method === "v4/command")).toHaveLength(1);
    expect(f.calls.some(call => call.method === "v4/commands/query")).toBe(true);
    expect(f.receipts.size).toBe(1);
  });

  it("does not advertise stopped owners, readonly children or dead descriptors", async () => {
    const f = await fixture();
    expect(await f.client.available({ ...session, readOnly: true })).toBe(false);
    expect(await new ZCodeDesktopBridge({ directory: f.directory, isAlive: () => false }).available(session)).toBe(false);
    f.end();
    expect(await f.client.available(session)).toBe(false);
    await expect(f.client.steer(session, "extra", "one")).rejects.toMatchObject({ code: "SESSION_OCCUPIED" });
    expect(f.receipts.size).toBe(0);
  });

  it("reads the original resident when its turn finishes after capability discovery", async () => {
    const f = await fixture();
    expect(await f.client.available(session)).toBe(true);
    f.end();
    await expect(f.client.read(session)).resolves.toMatchObject({ session: { sessionId: "sess" } });
    expect(f.calls.at(-1)?.method).toBe("read");
  });

  it("rejects publicly readable or symlink discovery records", async () => {
    const f = await fixture();
    await chmod(f.descriptor, 0o644);
    expect(await f.client.available(session)).toBe(false);
    await chmod(f.descriptor, 0o600);
    const original = f.descriptor + ".private";
    const data = await import("node:fs/promises");
    await data.rename(f.descriptor, original); await symlink(original, f.descriptor);
    expect(await f.client.available(session)).toBe(false);
  });
});
