import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@agent/core";
import { agentHost } from "./agent-host";
import { GET as runtimeHealth } from "./agent/runtime-health/route";
import { GET as listSessions, POST as createSession } from "./sessions/route";
import { DELETE as deleteSession, GET as getSession } from "./sessions/[id]/route";
import { POST as runRoute } from "./agent/run/route";
import { POST as answerRoute } from "./agent/answer/route";
import { POST as abortRoute } from "./agent/abort/route";
import { POST as steerRoute } from "./agent/steer/route";

const state = {
  health: [] as Array<Record<string, unknown>>,
  sessions: [] as Array<Record<string, unknown>>,
  detail: null as Record<string, unknown> | null,
  createOptions: null as Record<string, unknown> | null,
  runEvents: [] as AgentEvent[],
  runError: null as Error | null,
  answered: null as { questionId: string; answer: { answer: string; selectedIndices?: number[] } } | null,
  answerResult: false,
  aborts: [] as Array<string | undefined>,
  refreshCalls: 0,
};

vi.mock("../../lib/native-runtime-service", () => ({
  getNativeRuntimeService: () => ({
    health: async () => state.health,
    list: async () => state.sessions,
    refresh: async () => {
      state.refreshCalls += 1;
      return state.sessions;
    },
    create: async (options: Record<string, unknown>) => {
      state.createOptions = options;
      return {
        id: `runtime:${options.agentType}:bW9jaw`,
        agentType: options.agentType,
        nativeSessionId: "mock",
        title: options.title,
        cwd: options.cwd,
        created: "2026-08-31T00:00:00.000Z",
        updated: "2026-08-31T00:00:00.000Z",
        status: "idle",
        occupancy: "available",
        sourceLabel: options.agentType === "codex" ? "Codex" : "Claude Code",
        canResume: true,
        canDelete: false,
      };
    },
    get: async () => state.detail ?? (() => { throw new Error("not found"); })(),
    run: async function* () {
      if (state.runError) throw state.runError;
      yield* state.runEvents;
    },
    answerQuestion: async (questionId: string, answer: { answer: string; selectedIndices?: number[] }) => {
      state.answered = { questionId, answer };
      return state.answerResult;
    },
    abort: async (id?: string) => {
      state.aborts.push(id);
    },
  }),
  isNativeSessionId: (id: string) => /^runtime:(codex|claude-code):/.test(id),
  runtimeErrorStatus: () => 500,
}));

const codexSummary = {
  id: "runtime:codex:bW9jaw",
  agentType: "codex",
  nativeSessionId: "mock",
  title: "外部 Codex 会话",
  cwd: "/tmp/mock",
  created: "2026-08-31T00:00:00.000Z",
  updated: "2026-08-31T00:00:00.000Z",
  status: "idle",
  occupancy: "available",
  sourceLabel: "Codex",
  canResume: true,
  canDelete: false,
};

function json(method: string, url: string, body?: unknown): Request {
  return new Request(url, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function collectUntilTerminal(sessionId: string): { events: AgentEvent[]; settled: Promise<void> } {
  const events: AgentEvent[] = [];
  let resolveSettled!: () => void;
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  const unsubscribe = agentHost.subscribe(sessionId, (event) => {
    events.push(event);
    if (event.type === "done" || event.type === "error") {
      resolveSettled();
      unsubscribe();
    }
  });
  return { events, settled };
}

describe("native runtime routing", () => {
  beforeEach(() => {
    state.health = [
      { agentType: "codex", available: true, label: "Codex" },
      { agentType: "claude-code", available: true, label: "Claude Code" },
    ];
    state.sessions = [codexSummary];
    state.detail = { ...codexSummary, messages: [], events: [] };
    state.createOptions = null;
    state.runEvents = [];
    state.runError = null;
    state.answered = null;
    state.answerResult = false;
    state.aborts = [];
    state.refreshCalls = 0;
  });

  it("reports customer-agent plus native runtime health", async () => {
    const response = await runtimeHealth();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      { agentType: "customer-agent", available: true, label: "Customer Agent" },
      { agentType: "codex", available: true, label: "Codex" },
      { agentType: "claude-code", available: true, label: "Claude Code" },
    ]);
  });

  it("merges native sessions into the session list", async () => {
    const created = await agentHost.createSession("本地 CA 会话");
    const response = await listSessions(json("GET", "http://test/api/sessions"));
    expect(response.status).toBe(200);
    const sessions = await response.json();
    expect(sessions).toEqual(expect.arrayContaining([expect.objectContaining({ id: created.id, agentType: "customer-agent" })]));
    expect(sessions).toEqual(expect.arrayContaining([expect.objectContaining({ id: codexSummary.id, agentType: "codex" })]));
  });

  it("refreshes native discovery when ?refresh=1 is set", async () => {
    await listSessions(json("GET", "http://test/api/sessions?refresh=1"));
    expect(state.refreshCalls).toBe(1);
  });

  it("creates native sessions through the runtime service with a cwd", async () => {
    const response = await createSession(json("POST", "http://test/api/sessions", {
      title: "新会话",
      agentType: "codex",
    }));
    expect(response.status).toBe(201);
    expect(state.createOptions?.agentType).toBe("codex");
    expect(typeof state.createOptions?.cwd).toBe("string");
    const body = await response.json();
    expect(body.agentType).toBe("codex");
    expect(body.id).toBe("runtime:codex:bW9jaw");
  });

  it("serves native session detail from the runtime service", async () => {
    const response = await getSession(json("GET", "http://test/api/sessions/runtime:codex:bW9jaw"), {
      params: { id: "runtime:codex:bW9jaw" },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ id: codexSummary.id, messages: [] });
  });

  it("rejects deleting native sessions", async () => {
    const response = await deleteSession(json("DELETE", "http://test/api/sessions/runtime:codex:bW9jaw"), {
      params: { id: "runtime:codex:bW9jaw" },
    });
    expect(response.status).toBe(405);
  });

  it("streams native run events through the SSE bus without persisting them", async () => {
    const sessionId = "runtime:codex:bW9jaw";
    state.runEvents = [
      { type: "text_chunk", text: "hello " } as AgentEvent,
      { type: "text_chunk", text: "native" } as AgentEvent,
      { type: "done", finalText: "hello native" } as AgentEvent,
    ];
    const { events, settled } = collectUntilTerminal(sessionId);

    const response = await runRoute(json("POST", "http://test/api/agent/run", { input: "hi", sessionId }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ sessionId, streamUrl: `/api/agent/stream?sessionId=${sessionId}` });
    await settled;

    expect(events).toEqual(state.runEvents);
    await expect(agentHost.getSessionStore().get(sessionId)).resolves.toBeNull();
  });

  it("emits a terminal error event when a native run throws", async () => {
    const sessionId = "runtime:claude-code:bW9jaw";
    state.runError = new Error("Session is currently owned by another client");
    const { events, settled } = collectUntilTerminal(sessionId);

    await runRoute(json("POST", "http://test/api/agent/run", { input: "hi", sessionId }));
    await settled;

    expect(events.at(-1)).toMatchObject({ type: "error", message: "Session is currently owned by another client" });
  });

  it("falls back to the native service for ask_user approvals", async () => {
    state.answerResult = true;
    const response = await answerRoute(json("POST", "http://test/api/agent/answer", {
      questionId: "native-question",
      answer: "allow",
      selectedIndices: [0],
    }));
    expect(response.status).toBe(200);
    expect(state.answered).toEqual({
      questionId: "native-question",
      answer: { answer: "allow", selectedIndices: [0] },
    });
  });

  it("returns 404 when neither host nor native service knows the question", async () => {
    const response = await answerRoute(json("POST", "http://test/api/agent/answer", {
      questionId: "unknown",
      answer: "allow",
    }));
    expect(response.status).toBe(404);
  });

  it("aborts native sessions by unified id", async () => {
    const response = await abortRoute(json("POST", "http://test/api/agent/abort", {
      sessionId: "runtime:codex:bW9jaw",
    }));
    expect(response.status).toBe(200);
    expect(state.aborts).toEqual(["runtime:codex:bW9jaw"]);
  });

  it("refuses to steer native sessions", async () => {
    const response = await steerRoute(json("POST", "http://test/api/agent/steer", {
      input: "补充说明",
      sessionId: "runtime:codex:bW9jaw",
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ steered: false });
  });
});
