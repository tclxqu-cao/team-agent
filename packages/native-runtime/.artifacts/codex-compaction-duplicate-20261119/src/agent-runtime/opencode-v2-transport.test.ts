import { describe, expect, it, vi } from "vitest";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { createOpenCodeV2Client, createOpenCodeV2Fetch } from "./opencode-v2-transport.js";
import { OPENCODE_INTERRUPTED_EVENT, OpenCodeV2EventCodec, v2Message, v2Session } from "./opencode-v2-codec.js";

const base = "http://opencode.test";
const session = { id: "ses_1", projectID: "p1", location: { directory: "/repo" }, title: "work", time: { created: 1, updated: 2 } };
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

describe("OpenCode 2 API transport", () => {
  it("authenticates and maps projects, session envelopes, and active status through the existing SDK", async () => {
    const request = vi.fn<typeof fetch>(async (url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Basic private");
      const path = new URL(String(url)).pathname;
      if (path === "/api/project") return response([{ id: "p1", canonical: "/repo", time: { created: 1 } }]);
      if (path === "/api/session/active") return response({ data: { ses_1: { type: "running" } } });
      return response({ data: session });
    });
    const client = createOpencodeClient({ baseUrl: base, fetch: createOpenCodeV2Fetch(base, "Basic private", request), throwOnError: true });
    expect((await client.project.list()).data).toMatchObject([{ worktree: "/repo" }]);
    expect((await client.session.get({ path: { id: "ses_1" } })).data).toMatchObject({ directory: "/repo", id: "ses_1" });
    expect((await client.session.status()).data).toEqual({ ses_1: { type: "busy" } });
  });

  it("follows opaque history cursors in order instead of truncating at the first v2 page", async () => {
    const calls: URL[] = [];
    const request = vi.fn<typeof fetch>(async (url) => {
      const current = new URL(String(url)); calls.push(current);
      return response(current.searchParams.has("cursor")
        ? { data: [{ id: "msg_2", type: "assistant", time: { created: 2, completed: 3 }, content: [{ type: "text", text: "~/movie.mp4" }] }], cursor: {} }
        : { data: [{ id: "msg_1", type: "user", time: { created: 1 }, text: "make video" }], cursor: { next: "opaque+/cursor" } });
    });
    const client = createOpencodeClient({ baseUrl: base, fetch: createOpenCodeV2Fetch(base, "Basic private", request), throwOnError: true });
    const messages = (await client.session.messages({ path: { id: "ses_1" }, throwOnError: true })).data;
    expect(messages.map((entry) => entry.info.id)).toEqual(["msg_1", "msg_2"]);
    expect(messages[1].parts[0]).toMatchObject({ type: "text", text: "~/movie.mp4" });
    expect(calls[0].searchParams.get("order")).toBe("asc");
    expect(calls[1].searchParams.get("cursor")).toBe("opaque+/cursor");
    expect(calls[1].searchParams.has("order")).toBe(false);
  });

  it("rejects malformed lists and repeated pagination cursors", async () => {
    const malformed = createOpenCodeV2Fetch(base, "Basic private", async () => response({ data: "bad", cursor: {} }));
    await expect(malformed(`${base}/session`)).rejects.toThrow("list response");
    const cycling = createOpenCodeV2Fetch(base, "Basic private", async () => response({ data: [], cursor: { next: "same" } }));
    await expect(cycling(`${base}/session`)).rejects.toThrow("pagination cursor");
  });

  it("identifies a failed connection without leaking auth, cursors, or automatically resending", async () => {
    const request = vi.fn<typeof fetch>(async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("socket closed"), { code: "ECONNRESET" }) });
    });
    const transport = createOpenCodeV2Fetch(base, "Basic private", request);
    const error = await transport(`${base}/session/ses_1/message`).catch((error: Error) => error);
    expect(error).toMatchObject({ message: "OpenCode 2 GET /api/session/ses_1/message connection failed: fetch failed (ECONNRESET)" });
    expect(String(error)).not.toContain("Basic private");
    expect(String(error)).not.toContain("limit=");
    expect(request).toHaveBeenCalledOnce();
  });

  it("identifies the history response body that terminated after HTTP headers arrived", async () => {
    const request = vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"data":['));
        controller.error(new TypeError("terminated", { cause: Object.assign(new Error("closed"), { code: "UND_ERR_SOCKET" }) }));
      },
    })));
    const transport = createOpenCodeV2Fetch(base, "Basic private", request);
    await expect(transport(`${base}/session/ses_1/message`)).rejects.toThrow(
      "OpenCode 2 GET /api/session/ses_1/message response read failed: terminated (UND_ERR_SOCKET)",
    );
    expect(request).toHaveBeenCalledOnce();
  });

  it("maps prompt images, model selection, permission policy, interruption, fork, and permission reply", async () => {
    const calls: Array<{ path: string; method?: string; body: unknown }> = [];
    const request = vi.fn<typeof fetch>(async (url, init) => {
      const path = new URL(String(url)).pathname;
      calls.push({ path, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (init?.method === "GET") return response({ data: session });
      return path.endsWith("/fork") ? response({ data: { ...session, id: "ses_2" } }) : new Response(null, { status: 204 });
    });
    const client = createOpencodeClient({ baseUrl: base, fetch: createOpenCodeV2Fetch(base, "Basic private", request), throwOnError: true });
    await client.session.promptAsync({ path: { id: "ses_1" }, body: { messageID: "msg_1", model: { modelID: "m", providerID: "p" },
      parts: [{ type: "text", text: "hello" }, { type: "file", mime: "image/png", url: "data:image/png;base64,AAAA", filename: "image.png" }] } });
    await client.session.abort({ path: { id: "ses_1" } });
    await client.session.fork({ path: { id: "ses_1" }, body: { messageID: "msg_2" } });
    await client.postSessionIdPermissionsPermissionId({ path: { id: "ses_1", permissionID: "per_1" }, body: { response: "once" } });
    expect(calls).toEqual([
      { path: "/api/session/ses_1", method: "GET", body: undefined },
      { path: "/api/session/ses_1", method: "PATCH", body: { permissions: [{ action: "*", resource: "*", effect: "ask" }] } },
      { path: "/api/session/ses_1/model", method: "POST", body: { model: { id: "m", providerID: "p" } } },
      { path: "/api/session/ses_1/prompt", method: "POST", body: { id: "msg_1", delivery: "steer", text: "hello", files: [{ uri: "data:image/png;base64,AAAA", name: "image.png" }] } },
      { path: "/api/session/ses_1/interrupt", method: "POST", body: undefined },
      { path: "/api/session/ses_1/fork", method: "POST", body: { before: "msg_2" } },
      { path: "/api/session/ses_1/permission/per_1/reply", method: "POST", body: { decision: "once" } },
    ]);
  });

  it("propagates native steering admission errors rather than acknowledging a rejected prompt", async () => {
    const request = vi.fn<typeof fetch>(async (url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Basic private");
      if (String(url).endsWith("/prompt")) {
        expect(JSON.parse(String(init?.body))).toMatchObject({ text: "change direction", delivery: "steer" });
        return new Response(JSON.stringify({ message: "prompt conflict" }), { status: 409 });
      }
      return init?.method === "GET" ? response({ data: session }) : new Response(null, { status: 204 });
    });
    const client = createOpenCodeV2Client(base, "Basic private", request);
    await expect(client.session.promptAsync({ path: { id: "ses_1" }, body: {
      messageID: "msg_steer", parts: [{ type: "text", text: "change direction" }],
    }, throwOnError: true })).rejects.toThrow("OpenCode 2 HTTP 409: prompt conflict");
  });

  it("limits the always choice to the current session instead of saving a project permission", async () => {
    const calls: Array<{ path: string; method?: string; body: unknown }> = [];
    const transport = createOpenCodeV2Fetch(base, "Basic private", async (url, init) => {
      const path = new URL(String(url)).pathname;
      calls.push({ path, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (init?.method === "GET") return response({ data: path.includes("/permission/")
        ? { action: "bash", resources: ["pwd"], save: ["pwd *"] } : session });
      return new Response(null, { status: 204 });
    });
    await transport(`${base}/session/ses_1/permissions/per_1`, { method: "POST", body: JSON.stringify({ response: "always" }) });
    expect(calls.at(-2)).toMatchObject({ method: "PATCH", body: { permissions: [
      { action: "*", resource: "*", effect: "ask" }, { action: "bash", resource: "pwd *", effect: "allow" },
    ] } });
    expect(calls.at(-1)).toMatchObject({ path: "/api/session/ses_1/permission/per_1/reply", body: { decision: "once" } });
  });
});

describe("OpenCode 2 message and event conversion", () => {
  it("preserves fork ancestry without replacing an explicit subagent parent", () => {
    expect(v2Session({ ...session, fork: { sessionID: "ses_original", boundary: { type: "all" } } }))
      .toMatchObject({ parentID: "ses_original" });
    expect(v2Session({ ...session, parentID: "ses_parent", fork: { sessionID: "ses_original" } }))
      .toMatchObject({ parentID: "ses_parent" });
  });

  it("preserves reasoning, stable tool identity, output, and images from projected messages", () => {
    expect(v2Message({ id: "msg_1", type: "assistant", time: { created: 1, completed: 2 }, content: [
      { type: "reasoning", text: "thinking" },
      { type: "tool", id: "call_1", name: "read", time: { created: 1, completed: 2 }, state: { status: "completed", input: { path: "a" }, content: [{ type: "text", text: "ok" }] } },
    ] }, "ses_1")).toMatchObject({ info: { role: "assistant", time: { completed: 2 } }, parts: [
      { type: "reasoning", text: "thinking" }, { type: "tool", callID: "call_1", state: { output: "ok" } },
    ] });
    expect(v2Message({ id: "msg_2", type: "user", text: "image", files: [{ uri: "data:image/png;base64,AAAA" }] }, "ses_1"))
      .toMatchObject({ parts: [{ type: "text" }, { type: "file", mime: "image/png" }] });
  });

  it("uses identical part identities for live reasoning and native history", () => {
    const codec = new OpenCodeV2EventCodec(new Map([["ses_1", "/repo"]]));
    const content = [{ type: "reasoning", text: "inspect" }, { type: "text", text: "reply" }, { type: "reasoning", text: "verify" }];
    const history = v2Message({ id: "msg_1", type: "assistant", content }, "ses_1")!;
    const parts = history.parts as Array<{ id: string }>;
    for (const [ordinal, part] of content.entries()) {
      const live = codec.convert({ type: `session.${part.type}.ended`, data: {
        sessionID: "ses_1", assistantMessageID: "msg_1", ordinal, text: part.text,
      } });
      expect(live[0]).toMatchObject({ payload: { properties: { part: { id: parts[ordinal].id } } } });
    }
    const other = v2Message({ id: "msg_1", type: "assistant", content }, "ses_2")!;
    expect((other.parts as Array<{ id: string }>)[0].id).not.toBe(parts[0].id);
  });

  it("accumulates deltas and separates failed/interrupted executions from successful completion", () => {
    const codec = new OpenCodeV2EventCodec(new Map([["ses_1", "/repo"]]));
    const event = (type: string, data = {}) => codec.convert({ type, data: { sessionID: "ses_1", assistantMessageID: "msg_1", ordinal: 0, ...data } });
    expect(event("session.text.delta", { delta: "你" })[0]).toMatchObject({ payload: { properties: { part: { text: "你" } } } });
    expect(event("session.text.delta", { delta: "好" })[0]).toMatchObject({ payload: { properties: { part: { text: "你好" } } } });
    expect(event("session.text.ended", { text: "你好" })[0]).toMatchObject({ payload: { properties: { part: { text: "你好" } } } });
    expect(event("session.execution.failed", { error: { message: "bad" } })[0]).toMatchObject({ payload: { type: "session.error" } });
    expect(event("session.execution.interrupted")[0]).toMatchObject({ payload: { type: OPENCODE_INTERRUPTED_EVENT } });
    expect(event("session.execution.succeeded")[0]).toMatchObject({ payload: { type: "session.idle" } });
  });

  it("maps v2 shell approvals to the command permission classifier", () => {
    const codec = new OpenCodeV2EventCodec(new Map([["ses_1", "/repo"]]));
    expect(codec.convert({ type: "permission.asked", data: {
      id: "per_shell", sessionID: "ses_1", action: "shell", resources: ["pwd"],
    } })[0]).toMatchObject({ payload: { properties: { permission: "bash", patterns: ["pwd"] } } });
  });

  it("decodes fragmented UTF-8 and CRLF SSE without dropping or duplicating text", async () => {
    const source = { type: "session.text.delta", location: { directory: "/repo" }, data: { sessionID: "ses_1", assistantMessageID: "msg_1", ordinal: 0, delta: "你好" } };
    const bytes = new TextEncoder().encode(`: heartbeat\r\n\r\ndata: ${JSON.stringify(source)}\r\n\r\n`);
    const stream = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
    const client = createOpenCodeV2Client(base, "Basic private", async () => new Response(stream));
    const subscription = await client.global.event();
    const events = [];
    for await (const event of subscription.stream) events.push(event);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ directory: "/repo", payload: { properties: { part: { text: "你好" } } } });
  });
});
