import { describe, expect, it, vi } from "vitest";
import { agentHost } from "../../agent-host";
import { GET } from "./route";

const nativeState = vi.hoisted(() => ({
  afterSequence: null as number | null,
  events: [] as Array<{
    runId: string;
    sequence: number;
    event: { type: string; [key: string]: unknown };
  }>,
}));

vi.mock("../../../../lib/native-runtime-service", () => ({
  isNativeSessionId: (id: string) => id.startsWith("runtime:"),
  getNativeRuntimeService: () => ({
    snapshot: async (sessionId: string) => ({
      sessionId,
      runId: "native-run-new",
      snapshotRevision: 1,
      events: [],
      controller: "web",
    }),
    subscribe: async (
      _sessionId: string,
      afterSequence: number,
      listener: (entry: typeof nativeState.events[number]) => void,
    ) => {
      nativeState.afterSequence = afterSequence;
      queueMicrotask(() => nativeState.events.forEach(listener));
      return () => undefined;
    },
  }),
}));

describe("GET /api/agent/stream", () => {
  it("flushes a connection frame after the session subscriber is registered", async () => {
    const session = await agentHost.createSession("stream handshake test");
    const response = await GET(new Request(`http://test/api/agent/stream?sessionId=${session.id}`, {
      headers: { authorization: "Bearer test-token" },
    }));
    const reader = response.body?.getReader();

    const firstChunk = await Promise.race([
      reader?.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("stream handshake timed out")), 50)),
    ]);

    expect(firstChunk?.done).toBe(false);
    expect(new TextDecoder().decode(firstChunk?.value)).toBe(": connected\n\n");
    await reader?.cancel();
  });

  it("replays a new native run from sequence zero when the browser cursor belongs to an older run", async () => {
    nativeState.afterSequence = null;
    nativeState.events = [
      {
        runId: "native-run-new",
        sequence: 1,
        event: {
          type: "native_subagent_update",
          activity: {
            taskId: "task-1",
            parentToolCallId: "agent-tool",
            description: "Inspect",
            status: "running",
            messages: [{ role: "assistant", content: "Reading" }],
          },
        },
      },
      {
        runId: "native-run-new",
        sequence: 2,
        event: { type: "done", finalText: "recovered" },
      },
    ];
    const response = await GET(new Request(
      "http://test/api/agent/stream?sessionId=runtime:codex:abc&afterRunId=native-run-old&afterSequence=8",
    ));
    const reader = response.body?.getReader();
    const chunks: string[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const next = await Promise.race([
        reader?.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("native stream timed out")), 50)),
      ]);
      if (next?.done) break;
      chunks.push(new TextDecoder().decode(next?.value));
    }

    expect(nativeState.afterSequence).toBe(0);
    expect(chunks.join("")).toContain("id: native-run-new:1");
    expect(chunks.join("")).toContain('"type":"native_subagent_update"');
    expect(chunks.join("")).toContain('"content":"Reading"');
    expect(chunks.join("")).toContain('"finalText":"recovered"');
    await reader?.cancel();
  });
});
