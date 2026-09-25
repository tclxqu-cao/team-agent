import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../stores/agentStore";
import {
  loadCodexExecutionTracePage,
  loadProgressiveSessionHistoryPage,
  mergeProgressiveSessionHistoryPage,
  mergeRefreshedSessionHistory,
  resolveOlderHistoryCursor,
  restoreCodexExecutionTrace,
  restoreSessionHistoryPage,
} from "./session-history";

describe("resolveOlderHistoryCursor", () => {
  it("stops when the response explicitly has no more history", () => {
    expect(resolveOlderHistoryCursor("history.v1.1", {
      history: { hasMore: false, nextCursor: "history.v1.1" },
    }, 1)).toBeNull();
  });

  it("stops an empty page that repeats the requested cursor", () => {
    expect(resolveOlderHistoryCursor("history.v1.1", {
      history: { hasMore: true, nextCursor: "history.v1.1" },
    }, 0)).toBeNull();
  });

  it("preserves an advanced cursor for an empty compatibility page", () => {
    expect(resolveOlderHistoryCursor("history.v1.2", {
      history: { hasMore: true, nextCursor: "history.v1.1" },
    }, 0)).toBe("history.v1.1");
  });

  it("preserves normal populated-page pagination", () => {
    expect(resolveOlderHistoryCursor("history.v1.2", {
      history: { hasMore: true, nextCursor: "history.v1.1" },
    }, 2)).toBe("history.v1.1");
  });
});

describe("loadCodexExecutionTracePage", () => {
  it("refreshes the core revision and retries one stale trace request", async () => {
    const stale = Object.assign(new Error("stale"), { code: "STALE_SESSION_ANCHOR" });
    const getSession = vi.fn()
      .mockRejectedValueOnce(stale)
      .mockResolvedValueOnce({ history: { revision: "rev-2", delivery: "core" } })
      .mockResolvedValueOnce({ messages: [], history: { revision: "rev-2", delivery: "trace" } });

    const loaded = await loadCodexExecutionTracePage(
      { getSession },
      "session-1",
      { turnId: "turn-1", revision: "rev-1" },
    );

    expect(loaded).toMatchObject({ revision: "rev-2", recovered: true });
    expect(getSession.mock.calls.map(([, query]) => query)).toEqual([
      { view: "trace", revision: "rev-1", turnId: "turn-1" },
      { view: "core", limit: 50 },
      { view: "trace", revision: "rev-2", turnId: "turn-1" },
    ]);
  });

  it("does not retry non-stale trace failures", async () => {
    const failure = Object.assign(new Error("network"), { code: "NETWORK_ERROR" });
    const getSession = vi.fn().mockRejectedValue(failure);

    await expect(loadCodexExecutionTracePage(
      { getSession },
      "session-1",
      { turnId: "turn-1", revision: "rev-1" },
    )).rejects.toBe(failure);
    expect(getSession).toHaveBeenCalledOnce();
  });
});

describe("restoreSessionHistoryPage", () => {
  it("adds one stable Codex execution disclosure from core turn metadata", () => {
    const restored = restoreSessionHistoryPage({
      messages: [{
        historyId: "history-message.v1.0.user",
        role: "user",
        content: "run",
        presentation: { executionTrace: { turnId: "turn-1" } },
      }, { historyId: "history-message.v1.1.answer", role: "assistant", content: "done" }],
      events: [],
      history: { revision: "rev-1", delivery: "core" },
    });

    expect(restored.map((message) => message.id)).toEqual([
      "history-message.v1.0.user",
      "codex-execution-trace:turn-1",
      "history-message.v1.1.answer",
    ]);
    expect(restored[1].executionTrace).toEqual({
      turnId: "turn-1",
      revision: "rev-1",
      segmentIndex: 0,
    });
  });

  it("restores already-streamed Codex tools into the disclosure after a refresh", () => {
    const restored = restoreSessionHistoryPage({
      messages: [{
        historyId: "history-message.v1.0.user",
        role: "user",
        content: "run",
        presentation: { executionTrace: { turnId: "turn-1" } },
      }],
      events: [
        {
          type: "tool_call",
          turnId: "turn-1",
          toolCall: { id: "call-1", name: "shell", arguments: { command: "pwd" } },
        },
        {
          type: "tool_result",
          turnId: "turn-1",
          result: { toolCallId: "call-1", content: "/repo" },
        },
      ],
      history: { revision: "rev-1", delivery: "core" },
    });

    expect(restored).toHaveLength(2);
    expect(restored[1].toolCalls).toBeUndefined();
    expect(restored[1].executionTrace).toMatchObject({
      turnId: "turn-1",
      revision: "rev-1",
      liveMessages: [expect.objectContaining({
        toolCalls: [expect.objectContaining({ id: "call-1", result: "/repo" })],
      })],
    });
  });

  it("restores one execution-only trace without inserting another disclosure", () => {
    const restored = restoreCodexExecutionTrace({
      messages: [{ role: "user", content: "duplicate" }, {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-1", name: "shell", arguments: {} }],
      }, { role: "tool", content: "", toolCallId: "call-1", toolResultRef: {
        turnId: "turn-1", itemId: "call-1", revision: "rev-1", byteSize: 10,
      } }, { role: "assistant", content: "duplicate answer" }],
      events: [],
      history: { revision: "rev-1", delivery: "trace" },
    });

    expect(restored).toHaveLength(1);
    expect(restored[0].toolCalls?.[0].resultRef?.itemId).toBe("call-1");
    expect(restored[0].executionTrace).toBeUndefined();
  });

  it("preserves the stable history identity used by query navigation", () => {
    const [restored] = restoreSessionHistoryPage({
      messages: [{ historyId: "history-message.v1.rev.1", role: "user", content: "jump here" }],
      events: [],
    });

    expect(restored.id).toBe("history-message.v1.rev.1");
  });

  it("merges tool results in linear lookup order", () => {
    const restored = restoreSessionHistoryPage({
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call-1", name: "shell", arguments: { command: "pwd" } }],
        },
        { role: "tool", content: "/tmp", toolCallId: "call-1" },
      ],
      events: [],
    });

    expect(restored).toHaveLength(1);
    expect(restored[0].toolCalls?.[0].result).toBe("/tmp");
  });

  it("restores a lazy tool-result locator without hydrating its body", () => {
    const ref = { turnId: "turn-1", itemId: "call-1", revision: "rev-1", byteSize: 100_000 };
    const restored = restoreSessionHistoryPage({
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call-1", name: "shell", arguments: { command: "pwd" } }],
        },
        { role: "tool", content: "", toolCallId: "call-1", toolResultRef: ref },
      ],
      events: [],
    });

    expect(restored[0].toolCalls?.[0]).toMatchObject({ resultRef: ref });
    expect(restored[0].toolCalls?.[0].result).toBeUndefined();
  });

  it("restores event-only assistant output when persisted messages are incomplete", () => {
    const restored = restoreSessionHistoryPage({
      messages: [{ role: "user", content: "run" }],
      events: [
        { type: "text_chunk", text: "done" },
        { type: "tool_call", toolCall: { id: "call-1", name: "shell", arguments: {} } },
        { type: "tool_result", result: { toolCallId: "call-1", content: "ok" } },
      ],
    });

    expect(restored.map((message) => message.content)).toEqual(["run", "done"]);
    expect(restored[1].toolCalls?.[0].result).toBe("ok");
  });

  it("restores persisted Codex commentary into its owning turn trace", () => {
    const restored = restoreSessionHistoryPage({
      history: { delivery: "core", revision: "rev-1" },
      messages: [{
        role: "user",
        content: "deploy",
        presentation: { executionTrace: { turnId: "turn-1" } },
      }],
      events: [
        {
          type: "text_chunk",
          text: "正在打包",
          turnId: "turn-1",
          itemId: "commentary-1",
          messagePhase: "commentary",
        },
        {
          type: "text_chunk",
          text: "前端",
          turnId: "turn-1",
          itemId: "commentary-1",
          messagePhase: "commentary",
        },
        {
          type: "text_chunk",
          text: "发布完成",
          turnId: "turn-1",
          itemId: "answer-1",
          messagePhase: "final_answer",
        },
      ],
    });

    expect(restored[1].executionTrace?.liveMessages).toEqual([expect.objectContaining({
      id: "codex-trace:turn-1:agent:commentary-1",
      content: "正在打包前端",
      presentation: { agentMessagePhase: "commentary" },
    })]);
  });

  it("restores one unresolved approval card from the persisted native event stream", () => {
    const restored = restoreSessionHistoryPage({
      messages: [{ role: "user", content: "deploy" }],
      events: [
        {
          type: "ask_user",
          questionId: "native:run-1:42",
          question: "Approve deployment?",
          options: [{ label: "允许一次", description: "once" }],
        },
      ],
    });

    expect(restored.filter((message) => message.askUser)).toEqual([
      expect.objectContaining({ askUser: expect.objectContaining({ questionId: "native:run-1:42" }) }),
    ]);
  });

  it("replaces a persisted ask_user tool call with a question-only card", () => {
    const restored = restoreSessionHistoryPage({
      messages: [
        { role: "user", content: "release" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call-ask", name: "ask_user", arguments: { question: "Version?" } }],
        },
      ],
      events: [{ type: "ask_user", questionId: "question-1", question: "Version?" }],
    });

    expect(restored.some((message) => message.toolCalls?.some((toolCall) => toolCall.name === "ask_user"))).toBe(false);
    expect(restored.filter((message) => message.askUser)).toEqual([
      expect.objectContaining({
        askUser: expect.objectContaining({ questionId: "question-1", question: "Version?" }),
      }),
    ]);
  });

  it("restores an async question on a core page without adding it to the execution trace", () => {
    const question = {
      type: "ask_user" as const, questionId: "native:run:async:item:0",
      question: "选择范围？", options: [{ label: "推荐", description: "" }],
    };
    const detail = {
      messages: [{ role: "user" as const, content: "计划", presentation: { executionTrace: { turnId: "turn" } } }],
      history: { delivery: "core" as const, revision: "rev", pageSize: 1, totalItems: 1, nextCursor: null, hasMore: false },
      events: [question, question],
    };
    const restored = restoreSessionHistoryPage(detail);
    expect(restored.filter((message) => message.askUser)).toHaveLength(1);
    expect(restored.find((message) => message.executionTrace)?.executionTrace?.liveMessages ?? []).toEqual([]);
    expect(restoreSessionHistoryPage({
      ...detail, events: [question, { type: "approval_resolved", questionId: question.questionId }],
    }).some((message) => message.askUser)).toBe(false);
  });

  it("keeps native projection identity internal instead of rendering it as an agent name", () => {
    const [restored] = restoreSessionHistoryPage({
      messages: [{
        role: "user",
        content: "long-running goal",
        name: "__native_run:run-1",
      }],
      events: [],
    });

    expect(restored).toMatchObject({
      role: "user",
      content: "long-running goal",
      name: "__native_run:run-1",
    });
    expect(restored.agentName).toBeUndefined();
  });
});

function message(id: string, content: string): ChatMessage {
  return { id, role: "user", content, timestamp: 1 };
}

function assistant(id: string, content: string, toolCalls?: ChatMessage["toolCalls"]): ChatMessage {
  return { id, role: "assistant", content, toolCalls, timestamp: 1 };
}

describe("mergeRefreshedSessionHistory", () => {
  it("preserves loaded older pages and replaces the overlapping latest tail", () => {
    const current = ["old-1", "old-2", "tail-1", "tail-2"].map((content) => message(content, content));
    const refreshed = [message("new-tail-1", "tail-1"), message("new-tail-2", "tail-2 updated")];

    const merged = mergeRefreshedSessionHistory(current, refreshed);

    expect(merged.map((entry) => entry.content)).toEqual(["old-1", "old-2", "tail-1", "tail-2 updated"]);
    expect(merged[2].id).toBe("tail-1");
  });

  it("preserves an already loaded lazy result across a trace refresh", () => {
    const current = [
      message("user", "run"),
      assistant("assistant", "done", [{
        id: "call-1",
        name: "shell",
        arguments: { command: "pwd" },
        result: "/repo",
        resultRef: { turnId: "turn-1", itemId: "call-1", revision: "rev-1", byteSize: 5 },
      }]),
    ];
    const refreshed = [
      message("fresh-user", "run"),
      assistant("fresh-assistant", "done", [{
        id: "call-1",
        name: "shell",
        arguments: { command: "pwd" },
        resultRef: { turnId: "turn-1", itemId: "call-1", revision: "rev-1", byteSize: 5 },
      }]),
    ];

    expect(mergeRefreshedSessionHistory(current, refreshed)[1].toolCalls?.[0].result).toBe("/repo");
  });

  it("keeps the message that just moved beyond the refreshed page boundary", () => {
    const current = ["old", "boundary", "shared-1", "shared-2"].map((content) => message(content, content));
    const refreshed = [message("fresh-1", "shared-1"), message("fresh-2", "shared-2"), message("fresh-3", "new")];

    expect(mergeRefreshedSessionHistory(current, refreshed).map((entry) => entry.content)).toEqual([
      "old",
      "boundary",
      "shared-1",
      "shared-2",
      "new",
    ]);
  });

  it("does not erase visible history when a partial transcript yields no messages", () => {
    const current = [message("existing", "existing")];
    expect(mergeRefreshedSessionHistory(current, [])).toBe(current);
  });

  it("keeps queued messages after a native history tail refresh", () => {
    const current = [
      message("history", "working"),
      { ...message("queued", "follow up"), isQueued: true, queueItemId: "queue-1" },
    ];

    expect(mergeRefreshedSessionHistory(current, [message("fresh", "working")])).toEqual([
      expect.objectContaining({ id: "history", content: "working" }),
      current[1],
    ]);
  });

  it("replaces one live turn when persisted history groups its tools differently", () => {
    const current = [
      message("old-user", "earlier"),
      assistant("old-assistant", "earlier response"),
      message("live-user", "run"),
      assistant("live-tool", "", [{ id: "call-1", name: "shell", arguments: { command: "pwd" } }]),
      assistant("live-final", "done"),
    ];
    const refreshed = [
      { ...message("persisted-user", "run"), name: "__native_run:run-1" },
      assistant("persisted-final", "done", [{
        id: "call-1",
        name: "shell",
        arguments: { command: "pwd" },
        result: "/workspace",
      }]),
    ];

    const merged = mergeRefreshedSessionHistory(current, refreshed);

    expect(merged.map((entry) => [entry.role, entry.content])).toEqual([
      ["user", "earlier"],
      ["assistant", "earlier response"],
      ["user", "run"],
      ["assistant", "done"],
    ]);
    expect(merged.filter((entry) => entry.role === "assistant" && entry.content === "done")).toHaveLength(1);
    expect(merged[2].id).toBe("live-user");
    expect(merged.at(-1)?.toolCalls?.[0].result).toBe("/workspace");
  });

  it("keeps a complete streamed reply when the refreshed Codex turn is only a prefix", () => {
    const current = [
      message("live-user", "explain"),
      assistant("live-assistant", "Complete streamed reply"),
    ];
    const refreshed = [
      message("persisted-user", "explain"),
      assistant("persisted-assistant", "Complete streamed"),
    ];

    const merged = mergeRefreshedSessionHistory(current, refreshed);

    expect(merged.map((entry) => entry.content)).toEqual(["explain", "Complete streamed reply"]);
  });

  it("keeps a streamed suffix after tools while accepting refreshed tool results", () => {
    const current = [
      message("live-user", "run"),
      assistant("live-prefix", "Checking "),
      assistant("live-tool", "", [{ id: "call-1", name: "shell", arguments: { command: "pwd" } }]),
      assistant("live-suffix", "finished"),
    ];
    const refreshed = [
      message("persisted-user", "run"),
      assistant("persisted-tool", "Checking ", [{
        id: "call-1",
        name: "shell",
        arguments: { command: "pwd" },
        result: "/workspace",
      }]),
    ];

    const merged = mergeRefreshedSessionHistory(current, refreshed);

    expect(merged.filter((entry) => entry.role === "assistant").map((entry) => entry.content).join(""))
      .toBe("Checking finished");
    expect(merged.find((entry) => entry.toolCalls)?.toolCalls?.[0].result).toBe("/workspace");
  });

  it("does not borrow a suffix from the following turn", () => {
    const current = [
      message("first-user", "first"),
      assistant("first-assistant", "first complete"),
      message("second-user", "second"),
      assistant("second-assistant", "second complete"),
    ];
    const refreshed = [
      message("persisted-user", "first"),
      assistant("persisted-assistant", "first"),
      assistant("persisted-tool-1", "", [{ id: "call-1", name: "shell", arguments: {} }]),
      assistant("persisted-tool-2", "", [{ id: "call-2", name: "read", arguments: {} }]),
    ];

    const merged = mergeRefreshedSessionHistory(current, refreshed);

    expect(merged.filter((entry) => entry.role === "assistant").map((entry) => entry.content).join(""))
      .toBe("first complete");
  });

  it("preserves identical text in separate turns", () => {
    const current = [
      message("first-user", "repeat"),
      assistant("first-assistant", "same answer"),
      message("second-user", "repeat"),
      assistant("second-assistant", "same answer"),
    ];
    const refreshed = [
      message("persisted-user", "repeat"),
      assistant("persisted-assistant", "same answer"),
    ];

    const merged = mergeRefreshedSessionHistory(current, refreshed);

    expect(merged.map((entry) => [entry.role, entry.content])).toEqual([
      ["user", "repeat"],
      ["assistant", "same answer"],
      ["user", "repeat"],
      ["assistant", "same answer"],
    ]);
    expect(merged[0].id).toBe("first-user");
    expect(merged[2].id).toBe("second-user");
  });

  it("does not use an unsent queued message as a persisted turn boundary", () => {
    const queued = { ...message("queued", "repeat"), isQueued: true, queueItemId: "queue-1" };
    const current = [
      message("live-user", "repeat"),
      assistant("live-assistant", "live answer"),
      queued,
    ];
    const refreshed = [
      message("persisted-user", "repeat"),
      assistant("persisted-assistant", "persisted answer"),
    ];

    const merged = mergeRefreshedSessionHistory(current, refreshed);

    expect(merged.map((entry) => entry.content)).toEqual(["repeat", "persisted answer", "repeat"]);
    expect(merged.at(-1)).toBe(queued);
  });

  it("keeps optimistic images while refreshed history has no usable attachment", () => {
    const image = "data:image/png;base64,AAAA";
    const optimistic = { ...message("optimistic", "inspect"), images: [image] };
    const refreshed = message("refreshed", "inspect");

    expect(mergeRefreshedSessionHistory([optimistic], [refreshed])).toEqual([{
      ...refreshed,
      id: optimistic.id,
      timestamp: optimistic.timestamp,
      images: [image],
    }]);
  });

  it("switches from optimistic images to usable persisted attachments", () => {
    const image = "data:image/png;base64,AAAA";
    const optimistic = { ...message("optimistic", "inspect"), images: [image] };
    const refreshed = {
      ...message("refreshed", "inspect"),
      presentation: {
        attachments: [{ type: "image" as const, name: "image-1.png", dataUrl: image }],
      },
    };

    const merged = mergeRefreshedSessionHistory([optimistic], [refreshed]);

    expect(merged[0]).toMatchObject({
      id: optimistic.id,
      presentation: refreshed.presentation,
    });
    expect(merged[0].images).toBeUndefined();
  });
});

describe("loadProgressiveSessionHistoryPage", () => {
  it("commits Codex core messages without requesting page-wide trace data", async () => {
    const getSession = vi.fn(async () => ({
      messages: [{ role: "user", content: "question" }],
      history: { revision: "rev-1", delivery: "core" },
    }));
    const pages: string[] = [];

    await loadProgressiveSessionHistoryPage(
      { getSession },
      "runtime:codex:c2Vzc2lvbg",
      "codex",
      { limit: 50 },
      (_detail, phase) => pages.push(phase),
      () => true,
    );
    expect(pages).toEqual(["core"]);
    expect(getSession).toHaveBeenCalledOnce();
    expect(getSession).toHaveBeenNthCalledWith(1, "runtime:codex:c2Vzc2lvbg", { limit: 50, view: "core" });
  });

  it("ignores a core response after the selected request becomes stale", async () => {
    let resolveCore!: (value: unknown) => void;
    const core = new Promise((resolve) => { resolveCore = resolve; });
    const getSession = vi.fn(async () => core);
    const pages: string[] = [];
    let current = true;
    const loading = loadProgressiveSessionHistoryPage(
      { getSession },
      "runtime:codex:c2Vzc2lvbg",
      "codex",
      {},
      (_detail, phase) => pages.push(phase),
      () => current,
    );
    current = false;
    resolveCore({ messages: [], history: { revision: "rev-1", delivery: "core" } });
    await loading;

    expect(pages).toEqual([]);
  });

  it("keeps non-Codex history on one legacy request", async () => {
    const getSession = vi.fn(async () => ({ messages: [], history: { revision: "rev-1" } }));
    const pages: string[] = [];

    await loadProgressiveSessionHistoryPage(
      { getSession },
      "runtime:claude-code:c2Vzc2lvbg",
      "claude-code",
      { limit: 50 },
      (_detail, phase) => pages.push(phase),
      () => true,
    );

    expect(getSession).toHaveBeenCalledOnce();
    expect(getSession).toHaveBeenCalledWith("runtime:claude-code:c2Vzc2lvbg", { limit: 50 });
    expect(pages).toEqual(["full"]);
  });

  it("does not request trace after the backend reports a legacy full fallback", async () => {
    const getSession = vi.fn(async () => ({
      messages: [],
      history: { revision: "rev-1", delivery: "legacy-full" as const },
    }));
    const pages: string[] = [];

    await loadProgressiveSessionHistoryPage(
      { getSession },
      "runtime:codex:c2Vzc2lvbg",
      "codex",
      {},
      (_detail, phase) => pages.push(phase),
      () => true,
    );

    expect(getSession).toHaveBeenCalledOnce();
    expect(pages).toEqual(["core"]);
  });
});

describe("mergeProgressiveSessionHistoryPage", () => {
  it("updates every loaded execution disclosure to the latest session revision", () => {
    const liveMessages = [assistant("live-tool", "", [{
      id: "call-live",
      name: "shell",
      arguments: { command: "pwd" },
      result: "/repo",
    }])];
    const current = [
      message("old-user", "earlier"),
      { ...assistant("old-trace", ""), executionTrace: { turnId: "turn-old", revision: "rev-1" } },
      assistant("old-answer", "earlier answer"),
      message("tail-user", "run"),
      { ...assistant("tail-trace", ""), executionTrace: { turnId: "turn-tail", revision: "rev-1", liveMessages } },
      assistant("tail-answer", "partial"),
    ];
    const core = [
      message("core-tail-user", "run"),
      { ...assistant("core-tail-trace", ""), executionTrace: { turnId: "turn-tail", revision: "rev-2" } },
      assistant("core-tail-answer", "complete"),
    ];

    const merged = mergeProgressiveSessionHistoryPage(
      current,
      core,
      "core",
      { revision: "rev-2", delivery: "core" },
    );

    expect(merged.filter((entry) => entry.executionTrace).map((entry) => entry.executionTrace?.revision))
      .toEqual(["rev-2", "rev-2"]);
    expect(merged.find((entry) => entry.executionTrace?.turnId === "turn-tail")?.executionTrace?.liveMessages)
      .toEqual(liveMessages);
    expect(merged.at(-1)?.content).toBe("complete");
  });

  it("keeps visible trace messages while applying a core refresh", () => {
    const current = [
      message("user", "run"),
      {
        ...assistant("reasoning", ""),
        presentation: {
          reasoning: [{ itemId: "reasoning-1", sectionIndex: 0, text: "Inspecting" }],
        },
      },
      assistant("tool", "", [{ id: "call-1", name: "shell", arguments: { command: "pwd" } }]),
    ];
    const core = [message("core-user", "run")];

    const merged = mergeProgressiveSessionHistoryPage(
      current,
      core,
      "core",
      { revision: "rev-2", delivery: "core" },
    );

    expect(merged).toEqual(current);
  });

  it("shows growing core text without dropping existing reasoning or tools", () => {
    const current = [
      message("user", "run"),
      {
        ...assistant("reasoning", ""),
        presentation: {
          reasoning: [{ itemId: "reasoning-1", sectionIndex: 0, text: "Inspecting" }],
        },
      },
      assistant("tool", "", [{ id: "call-1", name: "shell", arguments: { command: "pwd" } }]),
      assistant("streamed", "partial"),
    ];
    const core = [message("core-user", "run"), assistant("core-streamed", "partial response keeps growing")];

    const merged = mergeProgressiveSessionHistoryPage(
      current,
      core,
      "core",
      { revision: "rev-2", delivery: "core" },
    );

    expect(merged.map((entry) => entry.content)).toEqual([
      "run",
      "",
      "",
      "partial response keeps growing",
    ]);
    expect(merged[1].presentation?.reasoning?.[0].text).toBe("Inspecting");
    expect(merged[2].toolCalls?.[0].id).toBe("call-1");
  });

  it("restores a fork history prefix without dropping its running optimistic turn", () => {
    const current = [
      message("optimistic-user", "continue"),
      assistant("live-tool", "", [{
        id: "call-live",
        name: "shell",
        arguments: { command: "pwd" },
      }]),
    ];
    const core = [
      message("history-message.v1.0.old", "earlier"),
      { ...assistant("old-trace", ""), executionTrace: { turnId: "turn-old", revision: "rev-2" } },
      assistant("history-message.v1.1.answer", "earlier answer"),
      message("history-message.v1.2.current", "continue"),
      { ...assistant("current-trace", ""), executionTrace: { turnId: "turn-current", revision: "rev-2" } },
    ];

    const merged = mergeProgressiveSessionHistoryPage(
      current,
      core,
      "core",
      { revision: "rev-2", delivery: "core" },
    );

    expect(merged.map((entry) => entry.content)).toEqual([
      "earlier",
      "",
      "earlier answer",
      "continue",
      "",
    ]);
    expect(merged[0].id).toBe("history-message.v1.0.old");
    expect(merged[3].id).toBe("optimistic-user");
    expect(merged[4].toolCalls?.[0].id).toBe("call-live");
  });

  it("applies the trace page after preserving the current history during core loading", () => {
    const current = [message("user", "run"), assistant("old-trace", "Checking")];
    const trace = [message("trace-user", "run"), assistant("new-trace", "Checking complete")];

    expect(mergeProgressiveSessionHistoryPage(
      current,
      trace,
      "trace",
      { revision: "rev-2", delivery: "trace" },
    ).map((entry) => entry.content)).toEqual(["run", "Checking complete"]);
  });

  it("still applies core immediately for an empty page or legacy full delivery", () => {
    const core = [message("core-user", "run")];
    expect(mergeProgressiveSessionHistoryPage(
      [],
      core,
      "core",
      { revision: "rev-2", delivery: "core" },
    )).toEqual(core);

    expect(mergeProgressiveSessionHistoryPage(
      [message("stale", "old")],
      core,
      "core",
      { delivery: "legacy-full" },
    ).map((entry) => entry.content)).toEqual(["run"]);
  });
});
