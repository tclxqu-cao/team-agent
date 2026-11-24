import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildSessionQueryIndex, paginateSessionHistory } from "@agent/core";
import { ZCodeClient } from "./zcode-client.js";
import type { NativeRpcConnection } from "./native-rpc-client.js";
import { NativeRpcError } from "./native-rpc-client.js";
import type { NativeJsonPacket } from "./native-stdio-channel.js";
import { readZCodeTurnDurations } from "./zcode-turn-duration.js";

function fixture(messages: NativeJsonPacket[], databasePath?: string) {
  const request = vi.fn<NativeRpcConnection["request"]>(async (method, params) => {
    if (method === "session/list") return { sessions: [{ sessionId: "large", title: "Large", status: "idle", workspace: { workspacePath: "/native" } }] };
    if (method === "session/subagents") return { childSessionIds: [] };
    if (method !== "session/messages" || params.direction !== "forward" || typeof params.limit !== "number") {
      throw new Error("Unbounded native snapshot/history must not be requested");
    }
    const cursor = params.afterMessageId ? messages.findIndex(row => (row.info as NativeJsonPacket).messageId === params.afterMessageId) : -1;
    if (params.afterMessageId && cursor < 0) throw new NativeRpcError("Message cursor is no longer available", -32602);
    const offset = cursor + 1;
    const result = { messages: messages.slice(offset, offset + params.limit) };
    if (Buffer.byteLength(JSON.stringify(result)) > 16 * 1024 * 1024) throw new Error("Native CLI output exceeds the line limit");
    return result;
  });
  const rpc: NativeRpcConnection = { request, notify: async () => {}, onNotification: () => () => {},
    onRequest: () => {}, onFailure: () => () => {}, dispose: async () => {} };
  return { request, client: new ZCodeClient(rpc, { readMany: async () => new Map() }, undefined, undefined,
    id => databasePath ? readZCodeTurnDurations(id, databasePath) : new Map()) };
}

const message = (index: number, content = `message-${index}`): NativeJsonPacket => ({
  info: { messageId: `msg-${index}`, role: index % 2 ? "assistant" : "user" },
  parts: [{ type: "text", partId: `part-${index}`, text: content }],
});

describe("ZCode bounded persisted history", () => {
  it("restores native completion timing by session and user message identity", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zcode-timing-"));
    const path = join(directory, "db.sqlite");
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    const database = new DatabaseSync(path);
    try {
      database.exec(`CREATE TABLE turn_usage (
        session_id TEXT, user_message_id TEXT, status TEXT, duration_ms INTEGER, completed_at INTEGER
      ); INSERT INTO turn_usage VALUES
        ('large', 'msg-0', 'completed', 65000, 66000),
        ('other', 'msg-0', 'completed', 99000, 100000),
        ('large', 'msg-2', 'completed', 0, 70000),
        ('large', 'msg-4', 'cancelled', 1200, 74000),
        ('large', 'msg-6', 'completed', 2000, 77000),
        ('large', 'msg-6', 'running', NULL, NULL),
        ('large', 'msg-8', 'completed', 1000, NULL);`);
      const { client } = fixture(Array.from({ length: 10 }, (_, index) =>
        message(index, index % 2 ? "same answer" : "same prompt")), path);
      const { messages } = await client.read("large");
      expect(messages.filter(row => row.role === "user").map(row => row.presentation?.completionDurationMs))
        .toEqual([65_000, 0, undefined, undefined, undefined]);
      const page = paginateSessionHistory(messages, [], { limit: 10 });
      expect(page.messages[0].presentation?.completionDurationMs).toBe(65_000);
      expect(readZCodeTurnDurations("large", join(directory, "missing.sqlite")).size).toBe(0);
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("distinguishes inline steering from queued inputs restored as new turns", async () => {
    const original = message(0, "original");
    const guided = message(2, "follow up");
    const queued = message(4, "follow up");
    const { client } = fixture([
      original,
      { ...guided, info: { ...guided.info as NativeJsonPacket, metadata: { turnSteerDelivery: "guide" } } },
      { ...queued, info: { ...queued.info as NativeJsonPacket, metadata: { turnSteerDelivery: "queue" } } },
    ]);

    const { messages } = await client.read("large");
    expect(messages.map(({ historyId, name }) => [historyId, name])).toEqual([
      ["msg-0", undefined],
      ["msg-2", "__native_steered:msg-2"],
      ["msg-4", undefined],
    ]);
  });

  it("loads history larger than one protocol frame and preserves paging and query anchors", async () => {
    const messages = Array.from({ length: 400 }, (_, index) => message(index, index % 2 ? "x".repeat(100_000) : `query-${index}`));
    expect(Buffer.byteLength(JSON.stringify({ messages }))).toBeGreaterThan(16 * 1024 * 1024);
    const { client, request } = fixture(messages);
    const detail = await client.read("large");
    expect(detail.messages).toHaveLength(400);
    expect(request.mock.calls.filter(([method]) => method === "session/messages").map(([, params]) => params.afterMessageId)).toEqual([undefined, "msg-255"]);
    const latest = paginateSessionHistory(detail.messages, [], { limit: 40 });
    expect(latest.messages.map(row => row.content)).toEqual(detail.messages.slice(-40).map(row => row.content));
    const previous = paginateSessionHistory(detail.messages, [], { before: latest.history.olderCursor!, limit: 40 });
    expect(previous.messages.map(row => row.content)).toEqual(detail.messages.slice(-80, -40).map(row => row.content));
    const index = buildSessionQueryIndex("large", detail.messages);
    const anchored = paginateSessionHistory(detail.messages, [], { anchor: index.entries[30].pageToken, limit: 40 });
    expect(anchored.messages.some(row => row.historyId === index.entries[30].messageId)).toBe(true);
  });

  it("keeps current DTO tool calls, tool results, reasoning and question identities", async () => {
    const row = { info: { messageId: "assistant", role: "assistant" }, parts: [
      { partId: "reasoning", type: "reasoning", text: "checking" },
      { partId: "tool", type: "tool", tool: "Read", callId: "call", state: { status: "completed", input: { path: "a" }, output: "result" } },
      { partId: "ask", type: "tool", tool: "AskUserQuestion", callId: "question", state: { status: "completed", input: { questions: [{ question: "Which?", options: [{ label: "A" }] }], answers: { "Which?": "A" } } } },
    ] };
    const { client } = fixture([row]);
    const { messages } = await client.read("large");
    expect(messages[0]).toMatchObject({ historyId: "assistant", presentation: { reasoning: [{ itemId: "reasoning" }] }, toolCalls: [{ id: "call" }] });
    expect(messages[1]).toMatchObject({ role: "tool", toolCallId: "call", content: "result" });
    expect(messages[2].presentation?.question).toMatchObject({ answer: "A", status: "answered" });
  });

  it("shares concurrent reads, checks the exact batch boundary, and refreshes appended history", async () => {
    const rows = Array.from({ length: 256 }, (_, index) => message(index));
    const { client, request } = fixture(rows);
    const [a, b] = await Promise.all([client.read("large"), client.read("large")]);
    expect(a).toBe(b);
    expect(a.messages).toHaveLength(256);
    expect(request.mock.calls.filter(([method]) => method === "session/messages")).toHaveLength(2);
    rows.push(message(256));
    expect((await client.read("large")).messages).toHaveLength(257);
  });

  it("preserves native Agent-only output and its error even without a final text response", async () => {
    const { client } = fixture([{ info: { messageId: "agent-only", role: "assistant" }, parts: [{
      type: "tool", partId: "agent-part", callID: "agent-call", tool: "Agent", state: {
        status: "error", input: { description: "Inspect", prompt: "Check files", subagent_type: "Explore" }, error: "Child stopped",
      },
    }] }]);
    const { messages } = await client.read("large");
    expect(messages).toHaveLength(2);
    expect(messages[0].toolCalls?.[0]).toMatchObject({ id: "agent-call", name: "Agent", arguments: { subagent_type: "Explore" } });
    expect(messages[1]).toMatchObject({ role: "tool", toolCallId: "agent-call", content: "Child stopped", isError: true });
  });

  it("fails a repeated cursor without looping and permits a later fresh read", async () => {
    const rows = Array.from({ length: 257 }, (_, index) => message(index));
    rows[256] = message(0);
    const { client } = fixture(rows);
    await expect(client.read("large")).rejects.toThrow("ZCode history cursor did not advance");
    rows[256] = message(256);
    expect((await client.read("large")).messages).toHaveLength(257);
  });

  it("refreshes mutable tail output without downloading the old prefix on every poll", async () => {
    const rows = Array.from({ length: 600 }, (_, index) => message(index));
    const { client, request } = fixture(rows);
    await client.read("large");
    request.mockClear();
    rows[599] = message(599, "updated tool output");
    expect((await client.read("large")).messages.at(-1)?.content).toBe("updated tool output");
    expect(request.mock.calls.find(([method]) => method === "session/messages")?.[1].afterMessageId).toBe("msg-343");
  });

  it("restarts from persisted history when a native rewind removes the incremental cursor", async () => {
    const rows = Array.from({ length: 600 }, (_, index) => message(index));
    const { client } = fixture(rows);
    await client.read("large");
    rows.splice(200);
    expect((await client.read("large")).messages).toHaveLength(200);
  });

  it("periodically reconciles older edits outside the mutable tail", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const rows = Array.from({ length: 600 }, (_, index) => message(index));
      const { client } = fixture(rows);
      await client.read("large");
      rows[0] = message(0, "corrected old input");
      vi.setSystemTime(Date.now() + 30_001);
      expect((await client.read("large")).messages[0].content).toBe("corrected old input");
    } finally { vi.useRealTimers(); }
  });
});
