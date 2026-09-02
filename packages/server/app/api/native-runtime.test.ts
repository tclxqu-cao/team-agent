import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@agent/core";
import { agentHost } from "./agent-host";
import { GET as runtimeHealth } from "./agent/runtime-health/route";
import { GET as listSessions, POST as createSession } from "./sessions/route";
import { DELETE as deleteSession, GET as getSession, PATCH as patchSession } from "./sessions/[id]/route";
import { POST as forkSession } from "./sessions/[id]/fork/route";
import { POST as handoffSession } from "./sessions/[id]/handoff/route";
import { POST as runRoute } from "./agent/run/route";
import { POST as answerRoute } from "./agent/answer/route";
import { POST as abortRoute } from "./agent/abort/route";
import { POST as steerRoute } from "./agent/steer/route";
import { RuntimeSessionError } from "../../../desktop/main/agent-runtime/types";

const state = {
  health: [] as Array<Record<string, unknown>>,
  sessions: [] as Array<Record<string, unknown>>,
  detail: null as Record<string, unknown> | null,
  createOptions: null as Record<string, unknown> | null,
  forkResult: null as Record<string, unknown> | null,
  forkError: null as Error | null,
  runEvents: [] as AgentEvent[],
  runError: null as Error | null,
  started: null as { id: string; input: string; images?: string[]; controller?: string } | null,
  answered: null as { questionId: string; answer: { answer: string; selectedIndices?: number[] } } | null,
  answerResult: false,
  answerError: null as Error | null,
  aborts: [] as Array<string | undefined>,
  steerResult: false,
  steerError: null as Error | null,
  steered: null as { id: string; input: string } | null,
  permissionUpdate: null as { id: string; permissionMode: string } | null,
  handoff: null as { id: string; controller: string } | null,
  refreshCalls: 0,
  getQuery: null as { before?: string; limit?: number } | null,
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
    fork: async () => {
      if (state.forkError) throw state.forkError;
      return state.forkResult;
    },
    get: async (_id: string, query?: { before?: string; limit?: number }) => {
      state.getQuery = query ?? null;
      return state.detail ?? (() => { throw new Error("not found"); })();
    },
    run: async function* () {
      if (state.runError) throw state.runError;
      yield* state.runEvents;
    },
    startRun: async (id: string, input: string, images?: string[], controller?: string) => {
      state.started = { id, input, images, controller };
      if (state.runError) throw state.runError;
      return { runId: "mock-native-run", snapshotRevision: 0, permissionMode: "full-access" };
    },
    subscribe: async (_id: string, _afterSequence: number, listener: (event: { runId: string; sequence: number; event: AgentEvent }) => void) => {
      let closed = false;
      queueMicrotask(() => {
        state.runEvents.forEach((event, index) => {
          if (!closed) listener({ runId: "mock-native-run", sequence: index + 1, event });
        });
      });
      return () => { closed = true; };
    },
    snapshot: async (id: string) => ({
      sessionId: id,
      runId: null,
      snapshotRevision: 0,
      events: [],
      controller: null,
    }),
    setPermissionMode: async (id: string, permissionMode: string) => {
      state.permissionUpdate = { id, permissionMode };
      return { ...codexSummary, id, permissionMode };
    },
    handoff: async (id: string, controller: string) => {
      state.handoff = { id, controller };
      return {
        sessionId: id,
        runId: null,
        snapshotRevision: 0,
        events: [],
        controller,
      };
    },
    answerQuestion: async (questionId: string, answer: { answer: string; selectedIndices?: number[] }) => {
      state.answered = { questionId, answer };
      if (state.answerError) throw state.answerError;
      return state.answerResult;
    },
    abort: async (id?: string) => {
      state.aborts.push(id);
    },
    steer: async (id: string, input: string) => {
      if (state.steerError) throw state.steerError;
      state.steered = { id, input };
      return state.steerResult;
    },
  }),
  isNativeSessionId: (id: string) => /^runtime:(codex|claude-code):/.test(id),
  runtimeErrorStatus: (error: { code?: string; status?: number }) => {
    if (error.code === "OPERATION_NOT_SUPPORTED") return 405;
    if (error.code === "APPROVAL_EXPIRED") return 409;
    return error.status ?? 500;
  },
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
  afterAll(async () => {
    await agentHost.getProjectStore().delete("native-runtime-test-project");
  });

  beforeEach(async () => {
    state.health = [
      { agentType: "codex", available: true, label: "Codex" },
      { agentType: "claude-code", available: true, label: "Claude Code" },
    ];
    state.sessions = [codexSummary];
    state.detail = { ...codexSummary, messages: [], events: [] };
    state.createOptions = null;
    state.forkResult = { ...codexSummary, id: "runtime:codex:Zm9yaw", nativeSessionId: "fork", title: "外部 Codex 会话（副本）" };
    state.forkError = null;
    state.runEvents = [];
    state.runError = null;
    state.started = null;
    state.answered = null;
    state.answerResult = false;
    state.answerError = null;
    state.aborts = [];
    state.steerResult = false;
    state.steerError = null;
    state.steered = null;
    state.permissionUpdate = null;
    state.handoff = null;
    state.refreshCalls = 0;
    state.getQuery = null;
    const store = agentHost.getProjectStore();
    const existing = await store.get("native-runtime-test-project");
    if (existing) {
      await store.update(existing.id, { description: process.cwd() });
    } else {
      const now = new Date().toISOString();
      await store.create({
        id: "native-runtime-test-project",
        name: "Native runtime test",
        description: process.cwd(),
        created: now,
        updated: now,
      });
    }
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
    await agentHost.getSessionStore().addMessage(created.id, {
      role: "user",
      content: "Only detail requests should include this message",
    });
    const response = await listSessions(json("GET", "http://test/api/sessions"));
    expect(response.status).toBe(200);
    const sessions = await response.json();
    expect(sessions).toEqual(expect.arrayContaining([expect.objectContaining({ id: created.id, agentType: "customer-agent" })]));
    expect(sessions).toEqual(expect.arrayContaining([expect.objectContaining({ id: codexSummary.id, agentType: "codex" })]));
    expect(sessions.find((session: { id: string }) => session.id === created.id)).not.toHaveProperty("messages");
    expect(sessions.find((session: { id: string }) => session.id === created.id)).not.toHaveProperty("events");
  });

  it("refreshes native discovery when ?refresh=1 is set", async () => {
    await listSessions(json("GET", "http://test/api/sessions?refresh=1"));
    expect(state.refreshCalls).toBe(1);
  });

  it("creates native sessions through the runtime service with a cwd", async () => {
    const response = await createSession(json("POST", "http://test/api/sessions", {
      title: "新会话",
      agentType: "codex",
      projectId: "native-runtime-test-project",
    }));
    expect(response.status).toBe(201);
    expect(state.createOptions?.agentType).toBe("codex");
    expect(typeof state.createOptions?.cwd).toBe("string");
    const body = await response.json();
    expect(body.agentType).toBe("codex");
    expect(body.id).toBe("runtime:codex:bW9jaw");
  });

  it("rejects native session creation without a registered project", async () => {
    const response = await createSession(json("POST", "http://test/api/sessions", {
      title: "无项目会话",
      agentType: "codex",
    }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "PROJECT_PATH_REQUIRED" },
    });
    expect(state.createOptions).toBeNull();
  });

  it("serves native session detail from the runtime service", async () => {
    const response = await getSession(json("GET", "http://test/api/sessions/runtime:codex:bW9jaw"), {
      params: { id: "runtime:codex:bW9jaw" },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ id: codexSummary.id, messages: [] });
  });

  it("forwards bounded history queries to the native runtime service", async () => {
    const response = await getSession(json(
      "GET",
      "http://test/api/sessions/runtime:codex:bW9jaw?before=history.v1.50&limit=50",
    ), {
      params: { id: "runtime:codex:bW9jaw" },
    });

    expect(response.status).toBe(200);
    expect(state.getQuery).toEqual({ before: "history.v1.50", limit: 50 });
  });

  it("creates a persisted native session fork", async () => {
    const response = await forkSession(json("POST", "http://test/api/sessions/runtime:codex:bW9jaw/fork", {}), {
      params: { id: "runtime:codex:bW9jaw" },
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      id: "runtime:codex:Zm9yaw",
      nativeSessionId: "fork",
    });
  });

  it("maps unsupported fork errors to the runtime status", async () => {
    state.forkError = Object.assign(new Error("This runtime does not support session forks"), { status: 405 });
    const response = await forkSession(json("POST", "http://test/api/sessions/runtime:claude-code:bW9jaw/fork", {}), {
      params: { id: "runtime:claude-code:bW9jaw" },
    });

    expect(response.status).toBe(405);
  });

  it("rejects deleting native sessions", async () => {
    const response = await deleteSession(json("DELETE", "http://test/api/sessions/runtime:codex:bW9jaw"), {
      params: { id: "runtime:codex:bW9jaw" },
    });
    expect(response.status).toBe(405);
  });

  it("persists native permission mode changes through the broker", async () => {
    const response = await patchSession(json("PATCH", "http://test/api/sessions/runtime:codex:bW9jaw", {
      permissionMode: "request-approval",
    }), {
      params: { id: "runtime:codex:bW9jaw" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ permissionMode: "request-approval" });
    expect(state.permissionUpdate).toEqual({
      id: "runtime:codex:bW9jaw",
      permissionMode: "request-approval",
    });
  });

  it("hands off only the requested native session to Desktop", async () => {
    const response = await handoffSession(json("POST", "http://test/api/sessions/runtime:codex:bW9jaw/handoff", {}), {
      params: { id: "runtime:codex:bW9jaw" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      sessionId: "runtime:codex:bW9jaw",
      controller: "desktop",
    });
    expect(state.handoff).toEqual({ id: "runtime:codex:bW9jaw", controller: "desktop" });
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

    expect(events[0]).toMatchObject({ type: "run_admitted", _nativeRunId: "mock-native-run" });
    expect(events.slice(1)).toEqual(state.runEvents);
    expect(state.started).toEqual({ id: sessionId, input: "hi", images: undefined, controller: "web" });
    await expect(agentHost.getSessionStore().get(sessionId)).resolves.toBeNull();
  });

  it("returns conflict before replacing the prior native SSE replay", async () => {
    const sessionId = "runtime:claude-code:bW9jaw";
    state.runError = new RuntimeSessionError(
      "Session is currently owned by another client",
      "SESSION_OCCUPIED",
    );
    agentHost.publishExternal(sessionId, { type: "text_chunk", text: "existing native output" });

    const response = await runRoute(json("POST", "http://test/api/agent/run", { input: "hi", sessionId }));

    expect(response.status).toBe(409);
    expect(agentHost.getLatestEventId(sessionId)).toBe(1);
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

  it("returns a clear conflict when the native approval request has expired", async () => {
    state.answerError = new RuntimeSessionError(
      "This approval request is no longer active; the native turn was interrupted.",
      "APPROVAL_EXPIRED",
    );

    const response = await answerRoute(json("POST", "http://test/api/agent/answer", {
      questionId: "expired-native-question",
      answer: "allow",
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("no longer active"),
    });
  });

  it("aborts native sessions by unified id", async () => {
    const response = await abortRoute(json("POST", "http://test/api/agent/abort", {
      sessionId: "runtime:codex:bW9jaw",
    }));
    expect(response.status).toBe(200);
    expect(state.aborts).toEqual(["runtime:codex:bW9jaw"]);
  });

  it("steers an active Claude Code native session", async () => {
    state.steerResult = true;
    const response = await steerRoute(json("POST", "http://test/api/agent/steer", {
      input: "补充说明",
      sessionId: "runtime:claude-code:bW9jaw",
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ steered: true });
    expect(state.steered).toEqual({
      id: "runtime:claude-code:bW9jaw",
      input: "补充说明",
    });
  });

  it("returns 405 when a native runtime does not support steering", async () => {
    state.steerError = new RuntimeSessionError(
      "This runtime does not support mid-turn steering",
      "OPERATION_NOT_SUPPORTED",
    );
    const response = await steerRoute(json("POST", "http://test/api/agent/steer", {
      input: "补充说明",
      sessionId: "runtime:codex:bW9jaw",
    }));

    expect(response.status).toBe(405);
    await expect(response.json()).resolves.toEqual({
      error: "This runtime does not support mid-turn steering",
    });
  });
});
