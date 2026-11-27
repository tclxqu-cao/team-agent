import { array, record, v2Message, v2Session, OpenCodeV2EventCodec } from "./opencode-v2-codec.js";
import { createOpencodeClient, type GlobalEvent, type OpencodeClient } from "@opencode-ai/sdk";
import { createOpenCodeQuestionClient, type OpenCodeQuestionClient } from "./opencode-questions.js";

export type OpenCodeRuntimeClient = OpencodeClient & { questions?: OpenCodeQuestionClient };

export function createOpenCodeV2Client(baseUrl: string, authorization: string, request: typeof fetch = fetch): OpenCodeRuntimeClient {
  const transport = createOpenCodeV2Fetch(baseUrl, authorization, request);
  const client = createOpencodeClient({ baseUrl, throwOnError: true, fetch: transport });
  // The legacy SDK's SSE implementation ignores its configured fetch adapter.
  client.global.event = async (options) => ({
    stream: readEvents(await transport(`${baseUrl}/global/event`, { signal: options?.signal })),
  });
  return Object.assign(client, { questions: createOpenCodeQuestionClient(baseUrl, "form", authorization, request) });
}

async function* readEvents(response: Response): AsyncGenerator<GlobalEvent> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (frame.startsWith("data: ")) yield JSON.parse(frame.slice(6)) as GlobalEvent;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function createOpenCodeV2Fetch(baseUrl: string, authorization: string, request: typeof fetch = fetch): typeof fetch {
  const directories = new Map<string, string>();
  const remember = (value: unknown) => {
    const session = v2Session(value);
    directories.set(session.id as string, session.directory as string);
    return session;
  };
  return async (input, init) => {
    const original = new Request(input, init);
    const url = new URL(original.url);
    const failure = (error: unknown, path: string, method: string, stage: string): Error => {
      if (original.signal.aborted) return error instanceof Error ? error : new Error(String(error));
      const cause = error instanceof Error ? error.cause : undefined;
      const code = cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string"
        ? ` (${cause.code})` : "";
      const message = error instanceof Error ? error.message : String(error);
      // Exclude query strings (including opaque cursors), auth and prompt bodies.
      return new Error(`OpenCode 2 ${method} ${new URL(path, baseUrl).pathname} ${stage}: ${message}${code}`, { cause: error });
    };
    const call = async (path: string, method = "GET", body?: unknown): Promise<Response> => {
      try {
        return await request(new URL(path, baseUrl), { method, signal: original.signal,
          headers: { Authorization: authorization, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      } catch (error) {
        throw failure(error, path, method, "connection failed");
      }
    };
    const json = async (path: string, method = "GET", body?: unknown): Promise<unknown> => {
      const response = await call(path, method, body);
      let value: unknown;
      try {
        value = response.status === 204 ? undefined : await response.json();
      } catch (error) {
        throw failure(error, path, method, "response read failed");
      }
      if (!response.ok) {
        const error = record(value);
        throw new Error(`OpenCode 2 HTTP ${response.status}: ${String(error.message ?? error._tag ?? "request failed")}`);
      }
      return value;
    };
    const pages = async (path: string): Promise<unknown[]> => {
      const result: unknown[] = [];
      const seen = new Set<string>();
      let next = path;
      while (true) {
        const page = record(await json(next));
        result.push(...array(page.data));
        const cursor = record(page.cursor).next;
        if (!cursor) return result;
        if (typeof cursor !== "string" || seen.has(cursor)) throw new Error("Invalid OpenCode 2 pagination cursor");
        seen.add(cursor);
        next = `${path.split("?")[0]}?limit=200&cursor=${encodeURIComponent(cursor)}`;
      }
    };
    const body = original.method === "GET" ? {} : record(JSON.parse((await original.text()) || "{}"));
    let result: unknown;
    if (url.pathname === "/global/event") {
      const response = await call("/api/event");
      if (!response.ok || !response.body) throw new Error(`OpenCode 2 event HTTP ${response.status}`);
      return convertEventStream(response, new OpenCodeV2EventCodec(directories));
    }
    if (url.pathname === "/project") {
      result = array(await json("/api/project")).map((value) => {
        const project = record(value);
        if (typeof project.canonical !== "string") throw new Error("Invalid OpenCode 2 project directory");
        return { ...project, worktree: project.canonical };
      });
    } else if (url.pathname === "/session/status") {
      const active = record(record(await json("/api/session/active")).data);
      result = Object.fromEntries(Object.keys(active).map((id) => [id, { type: "busy" }]));
    } else if (url.pathname === "/config/providers") {
      // The model endpoint waits for plugins; provider snapshots do not.
      const models = await json("/api/model");
      const providers = await json("/api/provider");
      result = { providers: array(record(providers).data).map((value) => {
        const provider = record(value);
        return { id: provider.id, name: provider.name, models: Object.fromEntries(array(record(models).data)
          .map(record).filter((model) => model.providerID === provider.id).map((model) => [String(model.id), { name: model.name }])) };
      }) };
    } else if (url.pathname === "/session" && original.method === "GET") {
      const directory = url.searchParams.get("directory");
      result = (await pages(`/api/session?limit=200&order=desc${directory ? `&directory=${encodeURIComponent(directory)}` : ""}`)).map(remember);
    } else if (url.pathname === "/session" && original.method === "POST") {
      result = remember(record(await json("/api/session", "POST", { ...body,
        location: { directory: url.searchParams.get("directory") },
        permissions: [{ action: "*", resource: "*", effect: "ask" }] })).data);
    } else {
      const match = /^\/session\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
      if (!match) throw new Error(`Unsupported OpenCode 2 SDK route: ${url.pathname}`);
      const id = decodeURIComponent(match[1]);
      const path = `/api/session/${encodeURIComponent(id)}`;
      const action = match[2] ?? "";
      if (!action && original.method === "GET") result = remember(record(await json(path)).data);
      else if (!action && original.method === "DELETE") { await json(path, "DELETE"); result = true; }
      else if (action === "message") {
        result = (await pages(`${path}/message?limit=200&order=asc`)).map((value) => v2Message(value, id)).filter(Boolean);
      } else if (action === "fork") {
        result = remember(record(await json(`${path}/fork`, "POST", body.messageID ? { before: body.messageID } : {})).data);
      } else if (action === "prompt_async") {
        const session = record(record(await json(path)).data);
        await json(path, "PATCH", { permissions: Array.isArray(session.permissions)
          ? session.permissions : [{ action: "*", resource: "*", effect: "ask" }] });
        if (body.model) {
          const model = record(body.model);
          await json(`${path}/model`, "POST", { model: { id: model.modelID, providerID: model.providerID } });
        }
        const parts = array(body.parts).map(record);
        await json(`${path}/prompt`, "POST", { id: body.messageID, delivery: "steer",
          text: parts.filter((part) => part.type === "text").map((part) => String(part.text ?? "")).join("\n"),
          files: parts.filter((part) => part.type === "file").map((part) => ({ uri: part.url, name: part.filename })) });
        return new Response(null, { status: 204 });
      } else if (action === "abort") {
        await json(`${path}/interrupt`, "POST");
        result = true;
      } else if (action.startsWith("permissions/")) {
        const permissionID = action.slice("permissions/".length);
        const permissionPath = `${path}/permission/${encodeURIComponent(decodeURIComponent(permissionID))}`;
        if (body.response === "always") {
          // AgentRoam's choice means this session; v2's native "always" saves
          // a project permission. Persist matching rules on the session instead.
          const permission = record(record(await json(permissionPath)).data);
          const session = record(record(await json(path)).data);
          const existing = Array.isArray(session.permissions) ? session.permissions : [{ action: "*", resource: "*", effect: "ask" }];
          const resources = array(permission.save ?? permission.resources);
          await json(path, "PATCH", { permissions: [...existing, ...resources.map((resource) => ({ action: permission.action, resource, effect: "allow" }))] });
        }
        await json(`${permissionPath}/reply`, "POST", { decision: body.response === "always" ? "once" : body.response });
        result = true;
      } else throw new Error(`Unsupported OpenCode 2 SDK route: ${url.pathname}`);
    }
    return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
  };
}

function convertEventStream(response: Response, codec: OpenCodeV2EventCodec): Response {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      // Accept CRLF even when a network chunk ends between CR and LF.
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (!data) continue;
        const value: unknown = JSON.parse(data);
        for (const event of codec.convert(value)) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
    },
  });
  return new Response(response.body!.pipeThrough(transform), { headers: { "Content-Type": "text/event-stream" } });
}
