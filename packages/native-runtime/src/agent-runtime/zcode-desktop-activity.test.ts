import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZCodeDesktopActivityReader } from "./zcode-desktop-activity.js";
import { ZCodeClient } from "./zcode-client.js";
import { ZCodeRuntimeAdapter } from "./zcode-runtime-adapter.js";
import type { NativeRpcConnection } from "./native-rpc-client.js";

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });
const start = new Date(2026, 9, 29, 11, 51, 20).getTime();
const session = { id: "session_desktop", cwd: "/native/workspace" };
const event = (name: string, turn = "turn-1", timestamp = start, id = session.id) =>
  JSON.stringify({ timestamp: new Date(timestamp).toISOString(), event: name, sessionId: id, turnId: turn }) + "\n";
const owner = (pid = 412, cwd = session.cwd, time = "2026-10-29 11:10:27.775") =>
  `[${time}] [info] [host-log] [zcode-agent] ZCode agent process started ${JSON.stringify({ workspaceKey: cwd, cwd, pid })}\n`;
const delivery = (options: { pid?: number; sessionId?: string; turnId?: string; kind?: string; applied?: boolean; time?: string } = {}) =>
  `[${options.time ?? "2026-10-29 11:51:20.100"}] [info] [pid:910] [main] [host-log] (local-1) [host] `
  + `[${options.time ?? "2026-10-29 11:51:20.100"}] [pid:${options.pid ?? 512}] [cua-pip-session] [cua-pip-session] event delivery acknowledged `
  + JSON.stringify({ kind: options.kind ?? "turn-started", sessionId: options.sessionId ?? session.id,
    turnId: options.turnId ?? "turn-1", applied: options.applied ?? true, reason: "applied" }) + "\n";
const runtimeHeaders = (options: { pid?: number; sessionId?: string; turnId?: string; cwd?: string; time?: string } = {}) =>
  `[${options.time ?? "2026-10-29 11:51:20.100"}] [info] [pid:910] [main] [host-log] (local-1) [host] `
  + `[${options.time ?? "2026-10-29 11:51:20.100"}] [pid:${options.pid ?? 512}] [zcode-agent-service][trace:example] `
  + "收到 ZCode provider runtime headers 请求 "
  + JSON.stringify({ sessionId: options.sessionId ?? session.id, turnId: options.turnId ?? "turn-1",
    workspacePath: options.cwd ?? session.cwd }) + "\n";

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "zcode-desktop-activity-")); homes.push(home);
  const cli = join(home, ".zcode/cli/log"); const desktop = join(home, ".zcode/v2/logs");
  await Promise.all([mkdir(cli, { recursive: true }), mkdir(desktop, { recursive: true })]);
  const log = join(cli, "zcode-2026-10-29.jsonl"); const host = join(desktop, "2026-10-29.log");
  await Promise.all([writeFile(log, event("turn.started")), writeFile(host, owner())]);
  const alive = new Set([412]);
  const reader = new ZCodeDesktopActivityReader({ home, isProcessAlive: pid => alive.has(pid) });
  return { home, log, host, cli, desktop, alive, reader };
}

describe("ZCode desktop turn discovery", () => {
  it("recognizes the desktop turn independently of legacy idle session summaries", async () => {
    const { reader } = await fixture();
    expect((await reader.readMany([session])).get(session.id)).toBe(true);
  });

  it("recognizes the reported host-owned turn without the legacy workspace process log", async () => {
    const { reader, host, alive } = await fixture();
    await writeFile(host, delivery());
    alive.clear(); alive.add(512);
    expect((await reader.readMany([session])).get(session.id)).toBe(true);
    alive.clear(); alive.add(910);
    expect((await reader.readMany([session])).get(session.id)).toBe(false);
  });

  it("recognizes a desktop turn whose local host request has no delivery receipt", async () => {
    const { reader, host, alive } = await fixture();
    await writeFile(host, runtimeHeaders()); alive.clear(); alive.add(512);
    expect((await reader.readMany([session])).get(session.id)).toBe(true);
    alive.clear(); alive.add(910);
    expect((await reader.readMany([session])).get(session.id)).toBe(false);
  });

  it.each([
    { sessionId: "other-session" }, { turnId: "other-turn" }, { cwd: "/other/workspace" },
    { time: "2026-10-29 11:51:19.999" },
  ])("does not infer running from a mismatched local host request (%j)", async options => {
    const { reader, host, alive } = await fixture();
    await writeFile(host, runtimeHeaders(options)); alive.add(512);
    expect((await reader.readMany([session])).has(session.id)).toBe(false);
  });

  it.each(["turn.completed", "turn.failed"])("clears request-based activity on %s", async terminal => {
    const { reader, host, log, alive } = await fixture();
    await writeFile(host, runtimeHeaders()); alive.add(512);
    expect((await reader.readMany([session])).get(session.id)).toBe(true);
    await appendFile(log, event(terminal, "turn-1", start + 200));
    expect((await reader.readMany([session])).get(session.id)).toBe(false);
  });

  it("keeps an acknowledged end authoritative over a local host request", async () => {
    const { reader, host, alive } = await fixture();
    await writeFile(host, runtimeHeaders() + delivery({ kind: "turn-ended", time: "2026-10-29 11:51:20.200" }));
    alive.add(512);
    expect((await reader.readMany([session])).get(session.id)).toBe(false);
  });

  it("requires the inner execution host rather than the outer Electron process", async () => {
    const { reader, host, alive } = await fixture();
    await writeFile(host, runtimeHeaders().replace(/\[host\] \[[^\]]+\] \[pid:512\] /, ""));
    alive.add(910);
    expect((await reader.readMany([session])).has(session.id)).toBe(false);
  });

  it("does not let a late request from the preceding turn hide the current host", async () => {
    const { reader, host, log, alive } = await fixture();
    await appendFile(log, event("turn.started", "turn-2", start + 200));
    await writeFile(host, runtimeHeaders({ turnId: "turn-2", time: "2026-10-29 11:51:20.300" })
      + runtimeHeaders({ pid: 513, time: "2026-10-29 11:51:20.400" }));
    alive.add(512);
    expect((await reader.readMany([session])).get(session.id)).toBe(true);
  });

  it("retains a request arriving just before the CLI turn boundary is flushed", async () => {
    const { reader, host, log, alive } = await fixture();
    await writeFile(host, runtimeHeaders({ turnId: "turn-2", time: "2026-10-29 11:51:20.300" }));
    alive.add(512);
    expect((await reader.readMany([session])).has(session.id)).toBe(false);
    await appendFile(log, event("turn.started", "turn-2", start + 200));
    expect((await reader.readMany([session])).get(session.id)).toBe(true);
  });

  it("discards request ownership when the desktop log is truncated", async () => {
    const { reader, host, alive } = await fixture();
    await writeFile(host, runtimeHeaders()); alive.add(512);
    expect((await reader.readMany([session])).get(session.id)).toBe(true);
    await writeFile(host, "\n");
    expect((await reader.readMany([session])).has(session.id)).toBe(false);
  });

  it.each([
    { applied: false }, { sessionId: "unrelated-session" }, { turnId: "unrelated-turn" },
  ])("does not infer ownership from an unrelated or rejected delivery (%j)", async options => {
    const { reader, host, alive } = await fixture();
    await writeFile(host, delivery(options)); alive.add(512);
    expect((await reader.readMany([session])).has(session.id)).toBe(false);
  });

  it("clears host delivery ownership on the exact native terminal event", async () => {
    const { reader, host, log, alive } = await fixture();
    await writeFile(host, delivery()); alive.add(512);
    expect((await reader.readMany([session])).get(session.id)).toBe(true);
    await appendFile(log, event("turn.completed", "turn-1", start + 200));
    expect((await reader.readMany([session])).get(session.id)).toBe(false);
  });

  it("observes an acknowledged turn end before the CLI terminal log catches up", async () => {
    const { reader, host, alive } = await fixture();
    await writeFile(host, delivery()); alive.add(512);
    expect((await reader.readMany([session])).get(session.id)).toBe(true);
    await appendFile(host, delivery({ kind: "turn-ended", time: "2026-10-29 11:51:20.200" }));
    expect((await reader.readMany([session])).get(session.id)).toBe(false);
  });

  it("does not treat the live Electron PID as a host delivery owner", async () => {
    const { reader, host, alive } = await fixture();
    await writeFile(host, delivery().replace(/\[host\] \[[^\]]+\] \[pid:512\] /, ""));
    alive.add(910);
    expect((await reader.readMany([session])).has(session.id)).toBe(false);
  });

  it("does not use an old delivery to revive a new turn after the host exits", async () => {
    const { reader, host, log, alive } = await fixture();
    await writeFile(host, delivery()); alive.add(512);
    expect((await reader.readMany([session])).get(session.id)).toBe(true);
    await appendFile(log, event("turn.started", "turn-2", start + 200));
    await appendFile(host, delivery({ turnId: "turn-2", pid: 513, time: "2026-10-29 11:51:20.300" }));
    expect((await reader.readMany([session])).get(session.id)).toBe(false);
  });

  it.each(["turn.completed", "turn.failed"])("clears running on %s without waiting for timestamps to expire", async terminal => {
    const { reader, log } = await fixture();
    await reader.readMany([session]);
    await appendFile(log, event(terminal, "turn-1", start + 1));
    expect((await reader.readMany([session])).get(session.id)).toBe(false);
  });

  it("checks process liveness again even when no log bytes changed", async () => {
    const { reader, alive } = await fixture();
    expect((await reader.readMany([session])).get(session.id)).toBe(true);
    alive.clear();
    expect((await reader.readMany([session])).get(session.id)).toBe(false);
  });

  it("does not revive an interrupted turn under a replacement workspace process", async () => {
    const { reader, host, alive } = await fixture();
    await reader.readMany([session]);
    alive.delete(412); alive.add(413);
    await appendFile(host, owner(413, session.cwd, "2026-10-29 11:52:00.000"));
    expect((await reader.readMany([session])).get(session.id)).toBe(false);
  });

  it("does not hide a running chat when another workspace lane starts", async () => {
    const { reader, host, alive } = await fixture();
    await reader.readMany([session]);
    alive.add(413);
    await appendFile(host, owner(413, session.cwd, "2026-10-29 11:52:00.000"));
    expect((await reader.readMany([session])).get(session.id)).toBe(true);
  });

  it("does not infer running from workspace activity or an unrelated session", async () => {
    const { reader, log } = await fixture();
    await appendFile(log, event("turn.started", "other-turn", start + 1, "session_other"));
    expect((await reader.readMany([{ ...session, id: "unseen" }])).has("unseen")).toBe(false);
    expect((await reader.readMany([{ ...session, cwd: "/another/workspace" }])).has(session.id)).toBe(false);
  });

  it("does not let an old turn's late completion clear a newly started turn", async () => {
    const { reader, log } = await fixture();
    await reader.readMany([session]);
    await appendFile(log, event("turn.started", "turn-2", start + 1) + event("turn.completed", "turn-1", start + 2));
    expect((await reader.readMany([session])).get(session.id)).toBe(true);
    await appendFile(log, event("turn.completed", "turn-2", start + 3));
    expect((await reader.readMany([session])).get(session.id)).toBe(false);
  });

  it("joins a partial UTF-8 line only after the writer appends the newline", async () => {
    const { reader, log } = await fixture();
    const line = Buffer.from(JSON.stringify({ timestamp: new Date(start + 1).toISOString(), event: "turn.completed",
      sessionId: session.id, turnId: "turn-1", message: "任务完成" }) + "\n");
    const split = line.indexOf(Buffer.from("完成")) + 1;
    await appendFile(log, line.subarray(0, split));
    expect((await reader.readMany([session])).get(session.id)).toBe(true);
    await appendFile(log, line.subarray(split));
    expect((await reader.readMany([session])).get(session.id)).toBe(false);
  });

  it("continues a turn across daily log rotation and does not use update recency", async () => {
    const { reader, log, cli } = await fixture();
    await reader.readMany([session]);
    const next = join(cli, "zcode-2026-10-30.jsonl");
    await writeFile(next, event("tool.call.completed", "turn-1", start + 24 * 60 * 60 * 1000));
    expect((await reader.readMany([session])).get(session.id)).toBe(true);
    await appendFile(next, event("turn.completed", "turn-1", start + 25 * 60 * 60 * 1000));
    expect((await reader.readMany([session])).get(session.id)).toBe(false);
    await rm(log);
    expect((await reader.readMany([session])).get(session.id)).toBe(false);
  });

  it("rebuilds lifecycle state after a log is replaced", async () => {
    const { reader, log } = await fixture();
    await reader.readMany([session]);
    await writeFile(log + ".replacement", event("turn.completed", "turn-1", start + 1));
    await rename(log + ".replacement", log);
    expect((await reader.readMany([session])).get(session.id)).toBe(false);
  });

  it("rebuilds after truncation instead of retaining a previous active turn", async () => {
    const { reader, log } = await fixture();
    await reader.readMany([session]);
    await writeFile(log, "\n");
    expect((await reader.readMany([session])).has(session.id)).toBe(false);
  });

  it("ignores oversized and malformed lines without losing later terminal events", async () => {
    const { reader, log } = await fixture();
    await reader.readMany([session]);
    await appendFile(log, "x".repeat(150 * 1024) + '\n{"event":"turn.failed",bad}\n' + event("turn.completed", "turn-1", start + 1));
    expect((await reader.readMany([session])).get(session.id)).toBe(false);
  });

  it("shares concurrent discovery and handles missing native logs", async () => {
    const { reader, home } = await fixture();
    const results = await Promise.all([reader.readMany([session]), reader.readMany([session])]);
    expect(results.map(result => result.get(session.id))).toEqual([true, true]);
    await rm(join(home, ".zcode"), { recursive: true });
    expect((await reader.readMany([session])).size).toBe(0);
  });

  it.each(["legacy", "host", "request"])("projects desktop execution and completion through the client and adapter (%s)", async kind => {
    const { reader, log, host, alive } = await fixture();
    if (kind === "host") { await writeFile(host, delivery()); alive.clear(); alive.add(512); }
    if (kind === "request") { await writeFile(host, runtimeHeaders()); alive.clear(); alive.add(512); }
    const row = { sessionId: session.id, title: "VPN 工具聚合免费隧道与界面方案", status: "idle",
      workspace: { workspacePath: session.cwd }, createdAt: start - 1000, updatedAt: start };
    const request = vi.fn<NativeRpcConnection["request"]>(async method => {
      if (method === "session/list") return { sessions: [row] };
      if (method === "session/read" || method === "session/resume") return { session: row };
      if (method === "session/messages") return { messages: [] };
      return {};
    });
    const rpc: NativeRpcConnection = { request, notify: async () => {}, onRequest: () => {},
      onNotification: () => () => {}, onFailure: () => () => {}, dispose: async () => {} };
    const client = new ZCodeClient(rpc, reader); const adapter = new ZCodeRuntimeAdapter(client);
    expect((await adapter.discoverSessions())[0]).toMatchObject({ status: "running", occupancy: "owned-externally", canResume: false });
    expect(await adapter.getSession(session.id)).toMatchObject({ status: "running", occupancy: "owned-externally", canResume: false });
    await expect(async () => { for await (const _event of client.run(session.id, "must not send")) {} }).rejects.toMatchObject({ code: "SESSION_OCCUPIED" });
    await appendFile(log, event("turn.completed", "turn-1", start + 291_439));
    expect((await adapter.discoverSessions())[0]).toMatchObject({ status: "idle", occupancy: "available", canResume: true });
    expect(await adapter.getSession(session.id)).toMatchObject({ status: "idle", occupancy: "available", canResume: true });
    expect(request.mock.calls.some(([method]) => method === "session/send")).toBe(false);
  });
});
