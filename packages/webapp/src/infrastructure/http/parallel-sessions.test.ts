import { describe, expect, it, vi } from "vitest";
import { AgentHttpGateway } from "./agent-http-gateway";

describe("parallel session HTTP gateway", () => {
  it("creates and reopens associations through the shared authenticated transport", async () => {
    const http = { post: vi.fn().mockResolvedValue({ id: "group" }), get: vi.fn().mockResolvedValue({ id: "group" }) };
    const gateway = new AgentHttpGateway(http as never, {} as never);
    const input = { title: "question", cwd: "/repo", agentTypes: ["codex", "zcode"] as Array<"codex" | "zcode"> };
    await expect(gateway.createParallelSessions(input)).resolves.toEqual({ id: "group" });
    await expect(gateway.getParallelSessionGroup("runtime:codex:1")).resolves.toEqual({ id: "group" });
    expect(http.post).toHaveBeenCalledWith("/api/sessions/parallel", input);
    expect(http.get).toHaveBeenCalledWith("/api/sessions/parallel?sessionId=runtime%3Acodex%3A1");
  });
});
