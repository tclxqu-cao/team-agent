import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@agent/core";
import { AsyncEventQueue } from "./async-event-queue";
import { DeepSeekHarnessRuntimeAdapter } from "./deepseek-harness-runtime-adapter";
import type { HarnessConnection, HarnessRecord } from "./deepseek-harness-client";

const row = { sessionId: "native", cwd: "/repo", updatedAt: 1 };
const configuration = { command: "node", args: [], env: { AGENTROAM_TODO_DESCRIPTOR: "dynamic-descriptor" } };
const finished = { type: "event", event: { type: "turn/end", seq: 2, data: { reason: { kind: "completed" } } } };
const collect = async (stream: AsyncIterable<AgentEvent>) => { const events: AgentEvent[] = []; for await (const event of stream) events.push(event); return events; };

function connection(frames: AsyncIterable<HarnessRecord>) {
  const request = vi.fn(async (method: string, _args?: HarnessRecord): Promise<unknown> => method === "session/list" ? { items: [row] } : { accepted: true });
  const close = vi.fn();
  const client: HarnessConnection = { request, follow: vi.fn(async () => ({ values: frames, close })), dispose: vi.fn(async () => undefined) };
  return { client, request, close };
}

describe("Harness session-scoped personal Todo command bridge", () => {
  it.each(["abort", "dispose"] as const)("does not follow or send after %s during Todo bridge preparation", async action => {
    const fixture = connection({ async *[Symbol.asyncIterator]() { yield { type: "snapshot" }; yield finished; } });
    let release!: (bridge: { wrap(input: string): string }) => void;
    const prepare = vi.fn(() => new Promise<{ wrap(input: string): string }>(resolve => { release = resolve; }));
    const adapter = new DeepSeekHarnessRuntimeAdapter(fixture.client, prepare);
    const execution = collect(adapter.run("native", "must not send", undefined, undefined, undefined, { todoMcp: configuration }));
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    await expect(collect(adapter.run("native", "concurrent"))).rejects.toMatchObject({ code: "SESSION_ALREADY_RUNNING" });
    await expect(adapter.steer("native", "too early")).resolves.toBe(false);
    if (action === "abort") await adapter.abort("native");
    else await adapter.dispose();
    release({ wrap: input => `internal:${input}` });
    expect(await execution).toEqual([{ type: "turn_aborted" }]);
    expect(fixture.client.follow).not.toHaveBeenCalled();
    expect(fixture.request.mock.calls.map(([method]) => method)).toEqual(["session/list"]);
  });

  it("does not send after cancellation while waiting for the initial native snapshot", async () => {
    const frames = new AsyncEventQueue<HarnessRecord>();
    const fixture = connection(frames);
    fixture.close.mockImplementation(() => frames.close());
    const adapter = new DeepSeekHarnessRuntimeAdapter(fixture.client, async () => ({ wrap: input => input }));
    const execution = collect(adapter.run("native", "must not send", undefined, undefined, undefined, { todoMcp: configuration }));
    await vi.waitFor(() => expect(fixture.client.follow).toHaveBeenCalledOnce());
    await adapter.abort("native");
    frames.push({ type: "snapshot" });
    expect(await execution).toEqual([{ type: "turn_aborted" }]);
    expect(fixture.request.mock.calls.some(([method]) => ["session/prompt", "subagents/prompt", "session/cancel", "subagents/interruptByParent"].includes(method))).toBe(false);
    expect(fixture.close).toHaveBeenCalledOnce();
  });

  it("wraps each run without altering official prompt fields or session writer ownership", async () => {
    const fixture = connection({ async *[Symbol.asyncIterator]() { yield { type: "snapshot" }; yield finished; } });
    const prepare = vi.fn(async () => ({ wrap: (input: string) => `private-tool-manual:${input}` }));
    const adapter = new DeepSeekHarnessRuntimeAdapter(fixture.client, prepare);
    for await (const _event of adapter.run("native", "create the personal Todo", undefined, undefined, undefined, { todoMcp: configuration })) { /* no model/tool execution */ }
    expect(prepare).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledWith(configuration);
    expect(fixture.request).toHaveBeenCalledWith("session/prompt", { request: {
      requestId: expect.any(String), sessionId: "native", mode: "queue",
      content: [{ type: "text", text: "private-tool-manual:create the personal Todo" }],
    } });
    expect(fixture.client.follow).toHaveBeenCalledOnce();
    expect(fixture.client.follow).toHaveBeenCalledWith({ address: { kind: "session", sessionId: "native" }, maxMessages: 1, assistantStream: true });
    expect(fixture.request.mock.calls.some(([method]) => /acp|mcp|create|resume|takeover|plugin/i.test(method))).toBe(false);
    fixture.request.mockClear();
    for await (const _event of adapter.run("native", "ordinary next turn")) { /* previous bridge must not leak */ }
    expect(fixture.request).toHaveBeenCalledWith("session/prompt", { request: {
      requestId: expect.any(String), sessionId: "native", mode: "queue", content: [{ type: "text", text: "ordinary next turn" }],
    } });
    expect(prepare).toHaveBeenCalledOnce();
  });

  it("keeps steering in the same admitted native run with the same restricted bridge", async () => {
    const queue = new AsyncEventQueue<HarnessRecord>();
    queue.push({ type: "snapshot" });
    const fixture = connection(queue);
    fixture.close.mockImplementation(() => queue.close());
    const prepare = vi.fn(async () => ({ wrap: (input: string) => `execution-only:${input}` }));
    const adapter = new DeepSeekHarnessRuntimeAdapter(fixture.client, prepare);
    const run = adapter.run("native", "start", undefined, undefined, undefined, { todoMcp: configuration });
    expect((await run[Symbol.asyncIterator]().next()).value).toMatchObject({ type: "thinking" });
    await expect(adapter.steer("native", "report progress")).resolves.toBe(true);
    expect(fixture.request).toHaveBeenLastCalledWith("session/prompt", { request: {
      requestId: expect.any(String), sessionId: "native", mode: "steer", content: [{ type: "text", text: "execution-only:report progress" }],
    } });
    queue.push(finished);
    for await (const _event of run) { /* finish the admitted native run */ }
    expect(prepare).toHaveBeenCalledOnce();
    await expect(adapter.steer("native", "after completion")).resolves.toBe(false);
  });

  it("fails visibly before native prompt dispatch when the bridge cannot be prepared", async () => {
    const fixture = connection({ async *[Symbol.asyncIterator]() { yield { type: "snapshot" }; yield finished; } });
    const adapter = new DeepSeekHarnessRuntimeAdapter(fixture.client, async () => { throw new Error("Selected Todo service is unavailable"); });
    const collect = async () => { for await (const _event of adapter.run("native", "create Todo", undefined, undefined, undefined, { todoMcp: configuration })) { /* must fail */ } };
    await expect(collect()).rejects.toMatchObject({ code: "OPERATION_NOT_SUPPORTED", message: expect.stringContaining("个人待办命令桥不可用") });
    expect(fixture.client.follow).not.toHaveBeenCalled();
    expect(fixture.request.mock.calls.map(([method]) => method)).toEqual(["session/list"]);
  });
});
