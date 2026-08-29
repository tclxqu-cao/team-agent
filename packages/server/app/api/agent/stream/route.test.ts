import { describe, expect, it } from "vitest";
import { agentHost } from "../../agent-host";
import { GET } from "./route";

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
});
