import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSessionQueryIndex, EngineSwitchLedger, paginateSessionHistory, scopedHistory,
  SQLiteDatabase, SQLiteEngineSwitchRepository, type EngineSwitchRecord, type Message,
  type SessionHistoryQuery } from "@agent/core";
import { EngineHistoryStore } from "./history-store";
const mocks = vi.hoisted(() => ({ ledger: null as unknown, store: null as unknown,
  get: vi.fn(), getQueryIndex: vi.fn(), getSessionToolResult: vi.fn() }));
vi.mock("./container", () => ({ getEngineSwitchContainer: () => ({ ledger: mocks.ledger }) }));
vi.mock("./history-store", async (original) => ({ ...await original<typeof import("./history-store")>(), getEngineHistoryStore: () => mocks.store }));
vi.mock("../native-runtime-service", () => ({ getNativeRuntimeService: () => mocks }));
import { loadEngineThreadHistory, loadEngineThreadQueryIndex, loadEngineThreadToolResult } from "./history";
import { GET } from "../../app/api/sessions/[id]/thread-history/route";

let directory: string, db: SQLiteDatabase, repository: SQLiteEngineSwitchRepository, store: EngineHistoryStore;
const msg = (content: string): Message => ({ role: "user", content });
const pair = (input: string): Message[] => [msg(input), { role: "assistant", content: `answer:${input}` }];
function record(id: string, from: string, to: string, messages: Message[], agentType: "codex" | "claude-code" | "opencode" = "claude-code"): EngineSwitchRecord {
  return { id, threadKey: "t", fromSessionId: from, fromAgentType: agentType, toSessionId: to,
    toAgentType: "opencode", strategy: "create", handoffId: null, coveredThroughHistoryId: null,
    sourceSnapshot: messages, phaseMessages: scopedHistory(messages, from, 0, id), at: "now" };
}
function setup(a: Message[], b: Message[] = [], activeType: "codex" | "opencode" = "opencode") {
  repository.records.append(record("ab", "A", "B", a));
  setActive("B", b, activeType);
}
function setActive(id: string, messages: Message[], agentType: "codex" | "opencode") {
  repository.threads.ensure({ threadKey: "t", currentSessionId: id, currentAgentType: agentType, created: "now", updated: "now" });
  mocks.get.mockImplementation(async (sid: string, query?: SessionHistoryQuery) => {
    expect(sid).toBe(id);
    if (!query) throw new Error("eager full native read is forbidden");
    const page = paginateSessionHistory(messages, [], query, { includePendingQuestions: true });
    return { id, agentType, cwd: "/tmp", title: "active", status: "running", occupancy: "owned-by-customer-agent",
      canResume: true, canDelete: false, nativePermissions: { mode: "test" },
      ...page, history: { ...page.history, delivery: agentType === "codex" ? "core" : "legacy-full" },
      goalState: { active: null, queued: [], history: [] } };
  });
  mocks.getQueryIndex.mockImplementation(async () => buildSessionQueryIndex(id, messages));
}
beforeEach(() => {
  vi.clearAllMocks();
  directory = mkdtempSync(join(tmpdir(), "engine-history-")); db = new SQLiteDatabase(directory);
  repository = new SQLiteEngineSwitchRepository(db.db); store = new EngineHistoryStore(db.db);
  mocks.ledger = new EngineSwitchLedger(repository); mocks.store = store;
});
afterEach(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });

describe("switched thread history performance and identity", () => {
  it("pages 300 frozen items without rereading snapshots or full native history", async () => {
    setup(Array.from({ length: 300 }, (_, index) => msg(`item-${index}`)));
    const raw = vi.spyOn(store, "raw");
    let before: string | undefined;
    const seen: string[] = [];
    for (let page = 0; page < 3; page++) {
      const response = await GET(new Request(`http://localhost/api/history?limit=100${before ? `&before=${encodeURIComponent(before)}` : ""}`), { params: { id: "A" } });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.history.totalItems).toBe(300); expect(body.activeSessionId).toBe("B");
      expect(body.status).toBe("running"); expect(body.canDelete).toBe(false);
      if (page === 0) { expect(body.omitted).toBe(200); expect(body.truncated).toBe(true); }
      seen.push(...body.messages.map((message: Message) => message.content)); before = body.history.nextCursor;
    }
    expect(new Set(seen).size).toBe(300); expect(before).toBeNull();
    expect(raw).toHaveBeenCalledTimes(1);
    expect(mocks.get.mock.calls.every(([id, query]) => id === "B" && query?.limit <= 100)).toBe(true);
  });

  it("keeps repeated prompts distinct and recovers full text by item identity", async () => {
    setup([msg("继续"), msg("x".repeat(6_000) + "TAIL")], [msg("继续")]);
    const loaded = await loadEngineThreadHistory("A");
    const prompts = loaded!.messages.filter((message) => message.content === "继续");
    expect(prompts).toHaveLength(2); expect(prompts[0].historyId).not.toBe(prompts[1].historyId);
    const long = loaded!.messages.find((message) => message.content.endsWith("TAIL"))!;
    const response = await GET(new Request(`http://localhost/api/history?itemId=${encodeURIComponent(long.historyId!)}&textOffset=4000`), { params: { id: "B" } });
    const body = await response.json(); expect(body.item.content).toHaveLength(2_004);
    expect(body.item.content).toMatch(/TAIL$/); expect(body.nextTextOffset).toBeNull();
  });

  it("keeps both paging directions contiguous across frozen/native phase boundaries", async () => {
    const inputs = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => pair(`${prefix}-${index}`)).flat();
    repository.records.append(record("ab", "A", "B", inputs("A", 12)));
    repository.records.append(record("bc", "B", "C", inputs("B", 13), "opencode"));
    repository.records.append(record("cd", "C", "D", []));
    setActive("D", inputs("D", 35), "opencode");
    const expected = [...Array.from({ length: 12 }, (_, index) => `A-${index}`),
      ...Array.from({ length: 13 }, (_, index) => `B-${index}`), ...Array.from({ length: 35 }, (_, index) => `D-${index}`)];
    for (const limit of [1, 3, 7, 50]) {
      let page = await loadEngineThreadHistory("D", { limit });
      const pages = [page!];
      const seenCursors = new Set<string>();
      while (page!.history.nextCursor) {
        const before = page!.history.nextCursor;
        expect(seenCursors.has(before)).toBe(false); seenCursors.add(before);
        page = await loadEngineThreadHistory("D", { before, limit }); pages.unshift(page!);
      }
      expect(pages.flatMap((part) => part.messages.filter((message) => message.role === "user").map((message) => message.content))).toEqual(expected);
    }
    const index = await loadEngineThreadQueryIndex("D");
    let page = await loadEngineThreadHistory("D", { anchor: index!.entries[23].pageToken, limit: 3 });
    const pages = [page!];
    const cursors = new Set<string>();
    while (page!.history.newerCursor) {
      const after = page!.history.newerCursor;
      expect(cursors.has(after)).toBe(false); cursors.add(after);
      page = await loadEngineThreadHistory("D", { after, limit: 3 }); pages.push(page!);
    }
    const collected = pages.flatMap((part) => part.messages.filter((message) => message.role === "user").map((message) => message.content));
    expect(collected).toEqual(expected.slice(expected.indexOf(collected[0])));
  });

  it("keeps frozen tool output unloaded and routes reused call ids to their own source", async () => {
    const tools = (result: string): Message[] => [msg("read"),
      { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "Read", arguments: { path: "file.txt" } }] },
      { role: "tool", content: result, toolCallId: "call-1" },
    ];
    setup(tools("A_OUTPUT"), tools("B_OUTPUT"));
    const body = await loadEngineThreadHistory("B");
    const results = body!.messages.filter((message) => message.role === "tool");
    expect(results.map((message) => message.content)).toEqual(["", "B_OUTPUT"]);
    expect(new Set(body!.messages.flatMap((message) => message.toolCalls?.map((call) => call.id) ?? [])).size).toBe(2);
    expect((await loadEngineThreadToolResult("B", results[0].toolResultRef!))?.content).toBe("A_OUTPUT");
    mocks.get.mockRejectedValue(new Error("active engine offline"));
    expect((await loadEngineThreadToolResult("B", results[0].toolResultRef!))?.content).toBe("A_OUTPUT");
    expect(mocks.getSessionToolResult).not.toHaveBeenCalled();
  });

  it("does not ship old Codex execution/tool bodies in core pages or prefetch", async () => {
    const huge = "secret-body:" + "x".repeat(2_000_000);
    const old = [...pair("old"), { role: "assistant" as const, content: "", toolCalls: [{ id: "call", name: "Read", arguments: { text: huge } }] },
      { role: "tool" as const, content: huge, toolCallId: "call" },
      { role: "assistant" as const, content: "", presentation: { reasoning: [{ itemId: "r", sectionIndex: 0, text: huge }] } }];
    repository.records.append(record("ab", "A", "B", old, "codex")); setActive("B", pair("new"), "opencode");
    const core = await loadEngineThreadHistory("B", { limit: 2 });
    const older = await loadEngineThreadHistory("B", { before: core!.history.nextCursor!, limit: 2 });
    expect(JSON.stringify(core).length).toBeLessThan(5000); expect(JSON.stringify(older).length).toBeLessThan(5000);
    expect(older!.history.delivery).toBe("core");
    const turnId = older!.messages.find((message) => message.role === "user")!.presentation!.executionTrace!.turnId;
    const trace = await loadEngineThreadHistory("B", { view: "trace", turnId, revision: older!.history.revision });
    expect(JSON.stringify(trace).length).toBeLessThan(12_000);
    const tool = trace!.messages.find((message) => message.role === "tool")!;
    expect(tool.content).toBe(""); expect(tool.toolResultRef?.byteSize).toBe(Buffer.byteLength(huge));
    const result = await loadEngineThreadToolResult("B", tool.toolResultRef!);
    expect(result?.content).toBe(huge);
    // The persisted lightweight index is independent of native session availability.
    const reopened = new EngineHistoryStore(db.db);
    expect(JSON.stringify(reopened.page("ab", 0, 2))).not.toContain("secret-body");
  });

  it("uses native core ordinals when returning to Codex after a tool-heavy phase", async () => {
    const old = pair("A-old");
    const boundary = paginateSessionHistory(old, [], { limit: 1 });
    repository.records.append({ ...record("ab", "A", "B", [...old,
      { role: "assistant", content: "", toolCalls: [{ id: "call", name: "Read", arguments: {} }] },
      { role: "tool", content: "output", toolCallId: "call" }], "codex"),
      sourceHistoryItemCount: 2, sourceHistoryLastId: boundary.messages.at(-1)!.historyId });
    repository.records.append(record("ba", "B", "A", pair("B-work"), "opencode"));
    setActive("A", [...old, ...pair("A-new")], "codex");
    const latest = await loadEngineThreadHistory("A", { limit: 2, view: "core" });
    expect(latest!.messages.filter((message) => message.role === "user").map((message) => message.content)).toEqual(["A-new"]);
    const index = await loadEngineThreadQueryIndex("A");
    expect(index!.entries.map((entry) => entry.preview)).toEqual(["A-old", "B-work", "A-new"]);
    for (const entry of index!.entries) {
      const page = await loadEngineThreadHistory("A", { anchor: entry.pageToken, limit: 2 });
      expect(page!.messages.some((message) => message.historyId === entry.messageId)).toBe(true);
    }
    const all = await loadEngineThreadHistory("A", { limit: 100 });
    expect(all!.messages.filter((message) => message.role === "user").map((message) => message.content)).toEqual(["A-old", "B-work", "A-new"]);
  });

  it("retains all active messages if a resumed source boundary no longer matches", async () => {
    const r = record("ab", "A", "B", pair("old"));
    repository.records.append({ ...r, sourceHistoryItemCount: 2, sourceHistoryLastId: "opaque-old-id" });
    repository.records.append(record("ba", "B", "A", [])); setActive("A", pair("compacted"), "codex");
    const page = await loadEngineThreadHistory("A", { limit: 100 });
    expect(page!.segments.at(-1)?.boundaryUncertain).toBe(true);
    expect(page!.messages.some((message) => message.content === "compacted")).toBe(true);
  });

  it("keeps active trace and tool identities compatible with live native events", async () => {
    setup(pair("old"), [{ ...msg("new"), presentation: { executionTrace: { turnId: "turn-native" } } }], "codex");
    const core = await loadEngineThreadHistory("B");
    expect(core!.messages.at(-1)?.presentation?.executionTrace?.turnId).toBe("turn-native");
    const original = mocks.get.getMockImplementation()!;
    mocks.get.mockImplementation(async (id, query) => query?.view === "trace" ? {
      ...await original(id, { limit: 1 }), messages: [
        { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "Read", arguments: {} }], presentation: { executionTrace: { turnId: "turn-native" } } },
        { role: "tool", content: "", toolCallId: "call-1", toolResultRef: { turnId: "turn-native", itemId: "call-1", revision: "native-rev", byteSize: 1 } },
      ],
    } : original(id, query));
    const trace = await loadEngineThreadHistory("B", { view: "trace", turnId: "turn-native", revision: core!.history.revision });
    expect(trace!.messages[0].toolCalls?.[0].id).toBe("call-1");
    mocks.getSessionToolResult.mockResolvedValue({ content: "ok" });
    expect(trace!.messages[1].toolResultRef).toEqual({ turnId: "turn-native", itemId: "call-1", revision: "native-rev", byteSize: 1 });
    expect(await loadEngineThreadToolResult("B", trace!.messages[1].toolResultRef!)).toBeNull();
    expect(mocks.getSessionToolResult).not.toHaveBeenCalled();
  });

  it("returns a stale-anchor code for cursors from a different switch generation", async () => {
    setup(pair("old"));
    const response = await GET(new Request("http://localhost/api/history?before=engine-history.v1.old-generation.2"), { params: { id: "B" } });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("STALE_SESSION_ANCHOR");
  });

  it("indexes unsnapshotted legacy history once and preserves explicit boundary uncertainty", async () => {
    const legacy = { ...record("ab", "A", "B", []), sourceSnapshot: undefined, phaseMessages: undefined };
    repository.records.append(legacy); setActive("B", [], "opencode");
    const activeGet = mocks.get.getMockImplementation()!;
    mocks.get.mockImplementation(async (id, query) => id === "A" && !query
      ? { id: "A", agentType: "claude-code", messages: pair("legacy"), events: [] }
      : activeGet(id, query));
    const first = await loadEngineThreadHistory("B", { limit: 100 });
    expect(first!.segments[0].boundaryUncertain).toBe(true);
    expect(first!.messages.some((message) => message.content === "legacy")).toBe(true);
    await loadEngineThreadHistory("B", { limit: 1 });
    expect(mocks.get.mock.calls.filter(([, query]) => !query)).toHaveLength(1);
    const itemId = first!.messages.find((message) => message.role === "user")!.historyId!;
    const response = await GET(new Request(`http://localhost/api/history?itemId=${encodeURIComponent(itemId)}`), { params: { id: "B" } });
    expect((await response.json()).item.content).toBe("legacy");
    expect(mocks.get.mock.calls.filter(([, query]) => !query)).toHaveLength(1);
  });

  it("recovers only an envelope prompt's preview using native core paging", async () => {
    const raw = "[引擎切换上下文交接 · A → B] context\n\n[agentroam:current-user-message]\nactual-question";
    setup(pair("old"), pair(raw), "codex");
    const get = mocks.get.getMockImplementation()!;
    mocks.get.mockImplementation(async (id, query) => {
      const page = await get(id, query);
      return { ...page, messages: page.messages.map((message: Message) => message.content === raw ? { ...message, content: "actual-question" } : message) };
    });
    const index = await loadEngineThreadQueryIndex("B");
    expect(index!.entries.at(-1)?.preview).toBe("actual-question");
    expect(mocks.get.mock.calls.filter(([, query]) => query?.anchor)).toHaveLength(1);
    await loadEngineThreadQueryIndex("B");
    expect(mocks.get.mock.calls.filter(([, query]) => query?.anchor)).toHaveLength(1);
  });

  it("leaves ordinary reads on the existing path without opening the history index", async () => {
    const raw = vi.spyOn(store, "raw");
    expect(await loadEngineThreadHistory("ordinary")).toBeNull();
    expect(mocks.get).not.toHaveBeenCalled(); expect(raw).not.toHaveBeenCalled();
  });
});
