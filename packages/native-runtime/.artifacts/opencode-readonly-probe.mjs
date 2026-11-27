// .artifacts/todo-mcp-all-agents-20261118/opencode-readonly-probe.ts
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// packages/native-runtime/src/agent-runtime/opencode-server-client.ts
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { logGlobal } from "@agent/core";
import { createServer } from "node:net";
import {
  createOpencodeClient as createOpencodeClient2
} from "@opencode-ai/sdk";

// packages/native-runtime/src/agent-runtime/types.ts
class RuntimeSessionError extends Error {
  code;
  constructor(message, code) {
    super(message);
    this.code = code;
    this.name = "RuntimeSessionError";
  }
}

// packages/native-runtime/src/agent-runtime/opencode-questions.ts
var OPENCODE_QUESTION_ASKED = "agentroam:opencode-question-asked";
var OPENCODE_QUESTION_RESOLVED = "agentroam:opencode-question-resolved";
function openCodeFormQuestion(value) {
  const form = record(value);
  if (!form.metadata || record(form.metadata).kind !== "question")
    return null;
  if (typeof form.id !== "string" || typeof form.sessionID !== "string")
    throw new Error("Invalid OpenCode question identity");
  const questions = array(form.fields).map((value2) => {
    const field = record(value2);
    if (typeof field.key !== "string" || field.type !== "string" && field.type !== "multiselect") {
      throw new Error("Unsupported OpenCode question field");
    }
    return {
      key: field.key,
      question: String(field.description ?? field.title ?? ""),
      multiSelect: field.type === "multiselect",
      options: array(field.options ?? []).map((value3) => {
        const option = record(value3);
        if (typeof option.value !== "string" || typeof option.label !== "string")
          throw new Error("Invalid OpenCode question option");
        return { value: option.value, label: option.label, description: String(option.description ?? "") };
      })
    };
  });
  if (!questions.length)
    throw new Error("Empty OpenCode question request");
  return { id: form.id, sessionID: form.sessionID, protocol: "form", questions };
}
function openCodeLegacyQuestion(value) {
  const request = record(value);
  if (typeof request.id !== "string" || typeof request.sessionID !== "string")
    throw new Error("Invalid OpenCode question identity");
  const questions = array(request.questions).map((value2, index) => {
    const question = record(value2);
    if (typeof question.question !== "string")
      throw new Error("Invalid OpenCode question text");
    return {
      key: `q${index}`,
      question: question.question,
      multiSelect: question.multiple === true,
      options: array(question.options ?? []).map((value3) => {
        const option = record(value3);
        if (typeof option.label !== "string")
          throw new Error("Invalid OpenCode question option");
        return { value: option.label, label: option.label, description: String(option.description ?? "") };
      })
    };
  });
  if (!questions.length)
    throw new Error("Empty OpenCode question request");
  return { id: request.id, sessionID: request.sessionID, protocol: "question", questions };
}
function createOpenCodeQuestionClient(baseUrl, protocol, authorization, fetchRequest = fetch) {
  const call = async (path, directory, body) => {
    const url = new URL(path, baseUrl);
    if (protocol === "question")
      url.searchParams.set("directory", directory);
    const response = await fetchRequest(url, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Accept: "application/json",
        ...authorization ? { Authorization: authorization } : {},
        ...body === undefined ? {} : { "Content-Type": "application/json" }
      },
      ...body === undefined ? {} : { body: JSON.stringify(body) }
    });
    if (!response.ok)
      throw new Error(`OpenCode question HTTP ${response.status}`);
    return response.status === 204 ? undefined : response.json();
  };
  return {
    async list(sessionID, directory) {
      if (protocol === "form") {
        const result = record(await call(`/api/session/${encodeURIComponent(sessionID)}/form`, directory));
        return array(result.data).flatMap((form) => {
          const question = openCodeFormQuestion(form);
          return question?.sessionID === sessionID ? [question] : [];
        });
      }
      return array(await call("/question", directory)).map(openCodeLegacyQuestion).filter((question) => question.sessionID === sessionID);
    },
    async reply(request, answers, directory) {
      if (protocol === "form") {
        const answer = Object.fromEntries(request.questions.map((question, index) => [
          question.key,
          question.multiSelect ? answers[index] : answers[index][0]
        ]));
        await call(`/api/session/${encodeURIComponent(request.sessionID)}/form/${encodeURIComponent(request.id)}/reply`, directory, { answer });
      } else {
        await call(`/question/${encodeURIComponent(request.id)}/reply`, directory, { answers });
      }
    }
  };
}

// packages/native-runtime/src/agent-runtime/opencode-v2-codec.ts
function record(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid OpenCode 2 object response");
  }
  return value;
}
function array(value) {
  if (!Array.isArray(value))
    throw new Error("Invalid OpenCode 2 list response");
  return value;
}
function optionalRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? record(value) : {};
}
function errorText(value) {
  if (typeof value === "string")
    return value;
  const error = optionalRecord(value);
  return typeof error.message === "string" ? error.message : JSON.stringify(value ?? "OpenCode failed");
}
function v2Session(value) {
  const session = record(value);
  const location = record(session.location);
  if (typeof session.id !== "string" || typeof location.directory !== "string") {
    throw new Error("Invalid OpenCode 2 session identity");
  }
  const fork = optionalRecord(session.fork);
  return {
    ...session,
    parentID: session.parentID ?? fork.sessionID,
    directory: location.directory,
    title: session.title ?? "新会话",
    version: "2"
  };
}
function contentText(value) {
  return array(value ?? []).map((item) => {
    const content = record(item);
    return content.type === "text" ? String(content.text ?? "") : "";
  }).filter(Boolean).join(`
`);
}
function v2Tool(value, sessionID, messageID) {
  const tool = record(value);
  const state = record(tool.state);
  const time = optionalRecord(tool.time);
  const status = state.status === "streaming" ? "pending" : state.status;
  const input = typeof state.input === "string" ? { raw: state.input } : optionalRecord(state.input);
  return {
    id: `${messageID}:tool:${tool.id}`,
    sessionID,
    messageID,
    type: "tool",
    callID: tool.id,
    tool: tool.name,
    state: {
      ...state,
      status,
      input,
      title: tool.name,
      metadata: optionalRecord(state.metadata),
      ...status === "completed" ? { output: contentText(state.content) } : {},
      ...status === "error" ? { error: errorText(state.error) } : {},
      time: { start: time.ran ?? time.created ?? 0, end: time.completed ?? 0 }
    }
  };
}
function v2Message(value, sessionID) {
  const message = record(value);
  if (message.type !== "user" && message.type !== "assistant" && message.type !== "synthetic")
    return null;
  if (typeof message.id !== "string")
    throw new Error("Invalid OpenCode 2 message identity");
  const messageID = message.id;
  const parts = [];
  const base = { sessionID, messageID };
  if (message.type === "assistant") {
    array(message.content).forEach((item, index) => {
      const content = record(item);
      if (content.type === "tool")
        parts.push(v2Tool(content, sessionID, messageID));
      else if (content.type === "text" || content.type === "reasoning") {
        const time = optionalRecord(content.time);
        parts.push({
          ...base,
          id: `${sessionID}:${messageID}:${content.type}:${index}`,
          type: content.type,
          text: content.text,
          time: { start: time.created ?? 0, end: time.completed }
        });
      }
    });
  } else {
    parts.push({ ...base, id: `${messageID}:text`, type: "text", text: message.text ?? "" });
    array(message.files ?? []).forEach((item, index) => {
      const file = record(item);
      const url = String(file.uri ?? "");
      parts.push({
        ...base,
        id: `${messageID}:file:${index}`,
        type: "file",
        url,
        mime: /^data:([^;,]+)/.exec(url)?.[1] ?? "application/octet-stream",
        filename: file.name
      });
    });
  }
  const model = optionalRecord(message.model);
  return { info: {
    ...message,
    sessionID,
    role: message.type === "assistant" ? "assistant" : "user",
    modelID: model.id,
    providerID: model.providerID
  }, parts };
}
var OPENCODE_INTERRUPTED_EVENT = "agentroam:opencode-interrupted";

class OpenCodeV2EventCodec {
  directories;
  text = new Map;
  tools = new Map;
  constructor(directories) {
    this.directories = directories;
  }
  convert(value) {
    const event = record(value);
    const data = optionalRecord(event.data);
    const type = String(event.type ?? "");
    const form = type === "form.created" ? optionalRecord(data.form) : data;
    const sessionID = typeof form.sessionID === "string" ? form.sessionID : undefined;
    if (!sessionID)
      return [];
    const location = optionalRecord(event.location);
    const directory = typeof location.directory === "string" ? location.directory : this.directories.get(sessionID);
    if (!directory)
      return [];
    this.directories.set(sessionID, directory);
    const emit = (type2, properties) => [{ directory, payload: { type: type2, properties } }];
    if (type === "form.created") {
      const question = openCodeFormQuestion(form);
      return question ? emit(OPENCODE_QUESTION_ASKED, { ...question }) : [];
    }
    if (type === "form.replied" || type === "form.cancelled") {
      return typeof data.id === "string" ? emit(OPENCODE_QUESTION_RESOLVED, { sessionID, id: data.id }) : [];
    }
    const messageID = String(data.assistantMessageID ?? "");
    if (type === "session.step.started") {
      return emit("message.updated", { info: { id: messageID, sessionID, role: "assistant", time: { created: data.started } } });
    }
    const textType = type.startsWith("session.reasoning.") ? "reasoning" : "text";
    if (/^session\.(text|reasoning)\.(delta|ended)$/.test(type)) {
      const id = `${sessionID}:${messageID}:${textType}:${data.ordinal}`;
      const previous = this.text.get(id) ?? "";
      const text = type.endsWith(".delta") ? previous + String(data.delta ?? "") : String(data.text ?? "");
      this.text.set(id, text);
      return emit("message.part.updated", { part: { id, messageID, sessionID, type: textType, text, time: { start: 0 } } });
    }
    if (type.startsWith("session.tool.")) {
      const key = `${sessionID}:${messageID}:${data.id}`;
      const tool = this.tools.get(key) ?? { id: data.id, name: "tool", time: { created: event.created ?? 0 } };
      if (type === "session.tool.input.started") {
        tool.name = data.name;
        this.tools.set(key, tool);
        return [];
      }
      const previous = optionalRecord(tool.state);
      if (type === "session.tool.called")
        tool.state = { status: "running", input: data.input, metadata: {} };
      else if (type === "session.tool.progress")
        tool.state = { ...previous, metadata: data.metadata };
      else if (type === "session.tool.success")
        tool.state = { ...previous, status: "completed", content: data.content, metadata: data.metadata };
      else if (type === "session.tool.failed")
        tool.state = { ...previous, status: "error", error: data.error, metadata: data.metadata };
      else
        return [];
      this.tools.set(key, tool);
      return emit("message.part.updated", { part: v2Tool(tool, sessionID, messageID) });
    }
    if (type === "permission.asked") {
      const metadata = optionalRecord(data.metadata);
      const files = Array.isArray(metadata.files) ? metadata.files.map(optionalRecord) : [];
      const patches = files.map((file) => file.patch).filter((patch) => typeof patch === "string");
      return emit(type, {
        ...data,
        permission: data.action === "shell" ? "bash" : data.action,
        patterns: data.resources,
        metadata: {
          ...metadata,
          ...files.length > 0 && patches.length === files.length ? { diff: patches.join(`
`) } : {}
        }
      });
    }
    if (type === "permission.replied")
      return emit(type, data);
    if (type === "session.retry.scheduled") {
      return emit("session.status", { sessionID, status: { type: "retry", attempt: data.attempt, message: errorText(data.error), next: data.at } });
    }
    if (type.startsWith("session.execution.") && type !== "session.execution.started") {
      for (const key of this.text.keys())
        if (key.startsWith(`${sessionID}:`))
          this.text.delete(key);
      for (const key of this.tools.keys())
        if (key.startsWith(`${sessionID}:`))
          this.tools.delete(key);
      if (type === "session.execution.failed")
        return emit("session.error", { sessionID, error: { message: errorText(data.error) } });
      if (type === "session.execution.interrupted")
        return emit(OPENCODE_INTERRUPTED_EVENT, { sessionID });
      if (type === "session.execution.succeeded")
        return emit("session.idle", { sessionID });
    }
    return [];
  }
}

// packages/native-runtime/src/agent-runtime/opencode-v2-transport.ts
import { createOpencodeClient } from "@opencode-ai/sdk";
function createOpenCodeV2Client(baseUrl, authorization, request = fetch) {
  const transport = createOpenCodeV2Fetch(baseUrl, authorization, request);
  const client = createOpencodeClient({ baseUrl, throwOnError: true, fetch: transport });
  client.global.event = async (options) => ({
    stream: readEvents(await transport(`${baseUrl}/global/event`, { signal: options?.signal }))
  });
  return Object.assign(client, { questions: createOpenCodeQuestionClient(baseUrl, "form", authorization, request) });
}
async function* readEvents(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder;
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done)
        return;
      buffer += decoder.decode(value, { stream: true });
      let end;
      while ((end = buffer.indexOf(`

`)) >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (frame.startsWith("data: "))
          yield JSON.parse(frame.slice(6));
      }
    }
  } finally {
    await reader.cancel().catch(() => {
      return;
    });
    reader.releaseLock();
  }
}
function createOpenCodeV2Fetch(baseUrl, authorization, request = fetch) {
  const directories = new Map;
  const remember = (value) => {
    const session = v2Session(value);
    directories.set(session.id, session.directory);
    return session;
  };
  return async (input, init) => {
    const original = new Request(input, init);
    const url = new URL(original.url);
    const failure = (error, path, method, stage) => {
      if (original.signal.aborted)
        return error instanceof Error ? error : new Error(String(error));
      const cause = error instanceof Error ? error.cause : undefined;
      const code = cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string" ? ` (${cause.code})` : "";
      const message = error instanceof Error ? error.message : String(error);
      return new Error(`OpenCode 2 ${method} ${new URL(path, baseUrl).pathname} ${stage}: ${message}${code}`, { cause: error });
    };
    const call = async (path, method = "GET", body2) => {
      try {
        return await request(new URL(path, baseUrl), {
          method,
          signal: original.signal,
          headers: { Authorization: authorization, Accept: "application/json", ...body2 === undefined ? {} : { "Content-Type": "application/json" } },
          ...body2 === undefined ? {} : { body: JSON.stringify(body2) }
        });
      } catch (error) {
        throw failure(error, path, method, "connection failed");
      }
    };
    const json = async (path, method = "GET", body2) => {
      const response = await call(path, method, body2);
      let value;
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
    const pages = async (path) => {
      const result2 = [];
      const seen = new Set;
      let next = path;
      while (true) {
        const page = record(await json(next));
        result2.push(...array(page.data));
        const cursor = record(page.cursor).next;
        if (!cursor)
          return result2;
        if (typeof cursor !== "string" || seen.has(cursor))
          throw new Error("Invalid OpenCode 2 pagination cursor");
        seen.add(cursor);
        next = `${path.split("?")[0]}?limit=200&cursor=${encodeURIComponent(cursor)}`;
      }
    };
    const body = original.method === "GET" ? {} : record(JSON.parse(await original.text() || "{}"));
    let result;
    if (url.pathname === "/global/event") {
      const response = await call("/api/event");
      if (!response.ok || !response.body)
        throw new Error(`OpenCode 2 event HTTP ${response.status}`);
      return convertEventStream(response, new OpenCodeV2EventCodec(directories));
    }
    if (url.pathname === "/project") {
      result = array(await json("/api/project")).map((value) => {
        const project = record(value);
        if (typeof project.canonical !== "string")
          throw new Error("Invalid OpenCode 2 project directory");
        return { ...project, worktree: project.canonical };
      });
    } else if (url.pathname === "/session/status") {
      const active = record(record(await json("/api/session/active")).data);
      result = Object.fromEntries(Object.keys(active).map((id) => [id, { type: "busy" }]));
    } else if (url.pathname === "/config/providers") {
      const models = await json("/api/model");
      const providers = await json("/api/provider");
      result = { providers: array(record(providers).data).map((value) => {
        const provider = record(value);
        return { id: provider.id, name: provider.name, models: Object.fromEntries(array(record(models).data).map(record).filter((model) => model.providerID === provider.id).map((model) => [String(model.id), { name: model.name }])) };
      }) };
    } else if (url.pathname === "/session" && original.method === "GET") {
      const directory = url.searchParams.get("directory");
      result = (await pages(`/api/session?limit=200&order=desc${directory ? `&directory=${encodeURIComponent(directory)}` : ""}`)).map(remember);
    } else if (url.pathname === "/session" && original.method === "POST") {
      result = remember(record(await json("/api/session", "POST", {
        ...body,
        location: { directory: url.searchParams.get("directory") },
        permissions: [{ action: "*", resource: "*", effect: "ask" }]
      })).data);
    } else {
      const match = /^\/session\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
      if (!match)
        throw new Error(`Unsupported OpenCode 2 SDK route: ${url.pathname}`);
      const id = decodeURIComponent(match[1]);
      const path = `/api/session/${encodeURIComponent(id)}`;
      const action = match[2] ?? "";
      if (!action && original.method === "GET")
        result = remember(record(await json(path)).data);
      else if (!action && original.method === "DELETE") {
        await json(path, "DELETE");
        result = true;
      } else if (action === "message") {
        result = (await pages(`${path}/message?limit=200&order=asc`)).map((value) => v2Message(value, id)).filter(Boolean);
      } else if (action === "fork") {
        result = remember(record(await json(`${path}/fork`, "POST", body.messageID ? { before: body.messageID } : {})).data);
      } else if (action === "prompt_async") {
        const session = record(record(await json(path)).data);
        await json(path, "PATCH", { permissions: Array.isArray(session.permissions) ? session.permissions : [{ action: "*", resource: "*", effect: "ask" }] });
        if (body.model) {
          const model = record(body.model);
          await json(`${path}/model`, "POST", { model: { id: model.modelID, providerID: model.providerID } });
        }
        const parts = array(body.parts).map(record);
        await json(`${path}/prompt`, "POST", {
          id: body.messageID,
          delivery: "steer",
          text: parts.filter((part) => part.type === "text").map((part) => String(part.text ?? "")).join(`
`),
          files: parts.filter((part) => part.type === "file").map((part) => ({ uri: part.url, name: part.filename }))
        });
        return new Response(null, { status: 204 });
      } else if (action === "abort") {
        await json(`${path}/interrupt`, "POST");
        result = true;
      } else if (action.startsWith("permissions/")) {
        const permissionID = action.slice("permissions/".length);
        const permissionPath = `${path}/permission/${encodeURIComponent(decodeURIComponent(permissionID))}`;
        if (body.response === "always") {
          const permission = record(record(await json(permissionPath)).data);
          const session = record(record(await json(path)).data);
          const existing = Array.isArray(session.permissions) ? session.permissions : [{ action: "*", resource: "*", effect: "ask" }];
          const resources = array(permission.save ?? permission.resources);
          await json(path, "PATCH", { permissions: [...existing, ...resources.map((resource) => ({ action: permission.action, resource, effect: "allow" }))] });
        }
        await json(`${permissionPath}/reply`, "POST", { decision: body.response === "always" ? "once" : body.response });
        result = true;
      } else
        throw new Error(`Unsupported OpenCode 2 SDK route: ${url.pathname}`);
    }
    return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
  };
}
function convertEventStream(response, codec) {
  const decoder = new TextDecoder;
  const encoder = new TextEncoder;
  let buffer = "";
  const transform = new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let match;
      while (match = /\r?\n\r?\n/.exec(buffer)) {
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join(`
`);
        if (!data)
          continue;
        const value = JSON.parse(data);
        for (const event of codec.convert(value))
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}

`));
      }
    }
  });
  return new Response(response.body.pipeThrough(transform), { headers: { "Content-Type": "text/event-stream" } });
}

// packages/native-runtime/src/agent-runtime/opencode-server-client.ts
var execFileAsync = promisify(execFile);

class OpenCodeServerClient {
  executable;
  unavailableError;
  environment;
  startPromise = null;
  process = null;
  stopEventStream = null;
  listeners = new Set;
  failureListeners = new Set;
  disposed = false;
  todoMcp;
  connection;
  constructor(options = {}) {
    this.executable = options.executable?.trim() || "opencode";
    this.unavailableError = options.unavailableError?.trim() || undefined;
    this.environment = options.environment ?? process.env;
    this.todoMcp = options.todoMcp;
  }
  async waitForTodoMcp(directory) {
    if (!this.todoMcp)
      return;
    await this.client();
    const connection = this.connection;
    if (!connection)
      throw new Error("OpenCode Todo MCP host is unavailable");
    const url = new URL(connection.v2 ? "/api/mcp" : "/mcp", connection.url);
    url.searchParams.set("directory", directory);
    const deadline = Date.now() + 30000;
    while (true) {
      const response = await fetch(url, {
        headers: connection.authorization ? { Authorization: connection.authorization } : {},
        signal: AbortSignal.timeout(5000)
      });
      if (!response.ok)
        throw new Error(`OpenCode Todo MCP discovery HTTP ${response.status}`);
      const body = await response.json();
      const servers = Array.isArray(body.data) ? body.data : [];
      const state = connection.v2 ? servers.find((server) => server.name === "agentroam-todo")?.status : body["agentroam-todo"];
      if (state?.status === "connected")
        return;
      if (state?.status && state.status !== "pending")
        throw new Error(`OpenCode Todo MCP is ${state.status}`);
      if (Date.now() >= deadline)
        throw new Error("OpenCode Todo MCP initialization timed out");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  async client() {
    if (this.disposed) {
      throw new RuntimeSessionError("OpenCode runtime has been disposed", "RUNTIME_UNAVAILABLE");
    }
    if (this.unavailableError) {
      throw new RuntimeSessionError(this.unavailableError, "RUNTIME_UNAVAILABLE");
    }
    this.startPromise ??= this.start();
    return this.startPromise;
  }
  subscribe(listener, onFailure) {
    this.listeners.add(listener);
    if (onFailure)
      this.failureListeners.add(onFailure);
    this.client().catch((error) => this.notifyFailure(normalizeError(error)));
    return () => {
      this.listeners.delete(listener);
      if (onFailure)
        this.failureListeners.delete(onFailure);
    };
  }
  async dispose() {
    this.disposed = true;
    this.stopEventStream?.();
    this.stopEventStream = null;
    const child = this.process;
    this.process = null;
    this.startPromise = null;
    if (!child || child.exitCode !== null)
      return;
    const exited = new Promise((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    const force = setTimeout(() => {
      if (child.exitCode === null)
        child.kill("SIGKILL");
    }, 2000);
    force.unref();
    await exited;
    clearTimeout(force);
  }
  async start() {
    const version = await execFileAsync(this.executable, ["--version"], { env: this.environment, timeout: 5000, windowsHide: true });
    const major = /(?:^|\s)v?(\d+)\./.exec(`${version.stdout}
${version.stderr}`)?.[1];
    const v2 = Number(major) >= 2;
    const password = v2 ? randomBytes(32).toString("base64url") : undefined;
    const authorization = password ? `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` : undefined;
    const port = await reservePort();
    const url = `http://127.0.0.1:${port}`;
    const child = spawn(this.executable, [
      "serve",
      ...v2 ? ["--stdio"] : [],
      "--hostname=127.0.0.1",
      `--port=${port}`
    ], {
      env: {
        ...this.environment,
        OPENCODE_CONFIG_CONTENT: openCodeTodoConfig(v2 ? this.environment.OPENCODE_CONFIG_CONTENT : openCodeServerConfig(this.environment.OPENCODE_CONFIG_CONTENT), this.todoMcp, v2),
        ...password ? { OPENCODE_PASSWORD: password, OPENCODE_SERVER_PASSWORD: password } : {}
      },
      stdio: [v2 ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true
    });
    this.process = child;
    let output = "";
    let spawnError = null;
    const collect = (chunk) => {
      output = `${output}${chunk.toString("utf8")}`.slice(-8000);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.once("error", (error) => {
      logGlobal("error", "opencode-server", "opencode server process error", error);
      spawnError = error;
    });
    try {
      await waitForHealth(url, child, () => output, () => spawnError, authorization);
    } catch (error) {
      if (child.exitCode === null)
        child.kill("SIGTERM");
      this.process = null;
      this.startPromise = null;
      throw error;
    }
    const client = authorization ? createOpenCodeV2Client(url, authorization) : Object.assign(createOpencodeClient2({ baseUrl: url, throwOnError: true }), {
      questions: createOpenCodeQuestionClient(url, "question")
    });
    child.once("exit", (code, signal) => {
      if (this.process !== child || this.disposed)
        return;
      this.process = null;
      this.startPromise = null;
      this.stopEventStream?.();
      this.stopEventStream = null;
      this.notifyFailure(new Error(`OpenCode server exited${code === null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}`));
    });
    this.startEventStream(client);
    this.connection = { url, authorization, v2 };
    return client;
  }
  startEventStream(client) {
    this.stopEventStream?.();
    this.stopEventStream = subscribeToOpenCodeEvents(client, {
      onEvent: (event) => {
        for (const listener of this.listeners) {
          try {
            listener(event);
          } catch (error) {
            console.warn("[opencode-server] Ignoring malformed event", normalizeError(error));
          }
        }
      },
      onEventError: (error) => {
        console.warn("[opencode-server] Ignoring malformed event", error);
      },
      onFailure: (error) => this.notifyFailure(error)
    });
  }
  notifyFailure(error) {
    for (const listener of this.failureListeners) {
      try {
        listener(error);
      } catch (listenerError) {
        console.warn("[opencode-server] Failure listener rejected an event", normalizeError(listenerError));
      }
    }
  }
}
function openCodeTodoConfig(content, configuration, v2) {
  if (!configuration)
    return content;
  const source = content ? JSON.parse(content) : {};
  const mcp = source.mcp && typeof source.mcp === "object" ? source.mcp : {};
  const server = {
    type: "local",
    command: [configuration.command, ...configuration.args],
    environment: { ...configuration.env },
    ...v2 ? { disabled: false, pool: false } : { enabled: true }
  };
  return JSON.stringify({ ...source, mcp: v2 ? { ...mcp, servers: { ...mcp.servers, "agentroam-todo": server } } : { ...mcp, "agentroam-todo": server } });
}
function subscribeToOpenCodeEvents(client, options) {
  let disposed = false;
  let currentAbort = null;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  const reconnectDelayMs = options.reconnectDelayMs ?? ((attempt) => Math.min(250 * 2 ** attempt, 5000));
  const reportEventError = (error) => {
    try {
      options.onEventError(normalizeError(error));
    } catch {}
  };
  const connect = () => {
    if (disposed)
      return;
    const abort = new AbortController;
    currentAbort = abort;
    client.global.event({ signal: abort.signal }).then(async ({ stream }) => {
      if (disposed || abort.signal.aborted)
        return;
      for await (const event of stream) {
        if (disposed || abort.signal.aborted)
          return;
        reconnectAttempt = 0;
        try {
          options.onEvent(event);
        } catch (error) {
          reportEventError(error);
        }
      }
      if (!disposed && !abort.signal.aborted) {
        handleDisconnect(abort, new Error("OpenCode event stream ended unexpectedly"));
      }
    }).catch((error) => {
      if (!disposed && !abort.signal.aborted)
        handleDisconnect(abort, normalizeError(error));
    });
  };
  const handleDisconnect = (abort, error) => {
    if (disposed || currentAbort !== abort)
      return;
    currentAbort = null;
    try {
      options.onFailure(error);
    } catch (failureError) {
      reportEventError(failureError);
    }
    const delay = Math.max(0, reconnectDelayMs(reconnectAttempt));
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };
  connect();
  return () => {
    disposed = true;
    currentAbort?.abort();
    currentAbort = null;
    if (reconnectTimer !== null)
      clearTimeout(reconnectTimer);
    reconnectTimer = null;
  };
}
async function reservePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to reserve a port for OpenCode"));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}
async function waitForHealth(url, child, output, spawnError, authorization) {
  const deadline = Date.now() + 1e4;
  while (Date.now() < deadline) {
    if (spawnError())
      throw spawnError();
    if (child.exitCode !== null) {
      throw new Error(`OpenCode server exited with code ${child.exitCode}: ${output().trim()}`);
    }
    try {
      const response = await fetch(`${url}${authorization ? "/api/info" : "/global/health"}`, {
        signal: AbortSignal.timeout(1000),
        headers: authorization ? { Authorization: authorization } : {}
      });
      if (response.ok && response.headers.get("content-type")?.includes("application/json")) {
        const identity = await response.json();
        if (authorization ? typeof identity.version === "string" : identity.healthy === true)
          return;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out starting OpenCode server: ${output().trim()}`);
}
function normalizeError(error) {
  return error instanceof Error ? error : new Error(String(error));
}
function openCodeServerConfig(raw) {
  let existing = {};
  try {
    const parsed = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      existing = parsed;
  } catch {}
  const permission = existing.permission && typeof existing.permission === "object" && !Array.isArray(existing.permission) ? existing.permission : {};
  return JSON.stringify({ ...existing, permission: { "*": "ask", ...permission } });
}

// packages/native-runtime/src/agent-runtime/runtime-tool-injection.ts
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
function nativeTodoMcpConfiguration(context) {
  const entry = createRequire(import.meta.url).resolve("@agent/native-runtime");
  const registry = context.discoveryDirectory ?? process.env.AGENTROAM_DISCOVERY_DIR;
  return { command: process.execPath, args: ["--input-type=module", "-e", `import(${JSON.stringify(pathToFileURL(entry).href)}).then(m=>m.runTodoMcpStdio({serviceId:${JSON.stringify(context.serviceId)}})).catch(e=>{console.error(e.message);process.exitCode=1})`], env: { AGENTROAM_TODO_DESCRIPTOR: context.descriptorPath, ...registry ? { AGENTROAM_DISCOVERY_DIR: registry } : {} } };
}

// .artifacts/todo-mcp-all-agents-20261118/opencode-readonly-probe.ts
var before = JSON.parse(await readFile(join(process.cwd(), ".artifacts/zcode-todo-mcp-20261118/runtime-before.json"), "utf8"));
var context = before.todoContext;
var temporary = await mkdtemp(join(tmpdir(), "agentroam-opencode-mcp-readonly-"));
var configuration = nativeTodoMcpConfiguration(context);
var host = new OpenCodeServerClient({
  todoMcp: configuration,
  environment: {
    ...process.env,
    XDG_CONFIG_HOME: join(temporary, "config"),
    XDG_DATA_HOME: join(temporary, "data"),
    XDG_CACHE_HOME: join(temporary, "cache"),
    OPENCODE_CONFIG_DIR: join(temporary, "opencode"),
    OPENCODE_CONFIG_CONTENT: "{}"
  }
});
var report = {
  capturedAt: new Date().toISOString(),
  phase: "starting",
  nativeModelTasksStarted: false,
  nativeSessionsCreated: false,
  todoWritesPerformed: false,
  globalConfigWritesPerformed: false,
  source: "isolated native OpenCode host with process-local mcp.servers config"
};
try {
  const started = Date.now();
  await host.client();
  report.hostReadyMs = Date.now() - started;
  try {
    await host.waitForTodoMcp(process.cwd());
    report.waitForTodoMcpPassed = true;
  } catch (error) {
    report.waitForTodoMcpError = error instanceof Error ? error.message : String(error);
  }
  const connection = host.connection;
  const url = new URL(connection.v2 ? "/api/mcp" : "/mcp", connection.url);
  url.searchParams.set("directory", process.cwd());
  const response = await fetch(url, { headers: connection.authorization ? { Authorization: connection.authorization } : {}, signal: AbortSignal.timeout(30000) });
  const body = await response.json();
  const servers = Array.isArray(body.data) ? body.data : [];
  const server = connection.v2 ? servers.find((server2) => server2.name === "agentroam-todo") : body["agentroam-todo"];
  const record2 = server && typeof server === "object" ? server : {};
  Object.assign(report, {
    phase: "connected",
    elapsedMs: Date.now() - started,
    transportVersion: connection.v2 ? 2 : 1,
    statusHttp: response.status,
    serverName: "agentroam-todo",
    serverResponseKeys: Object.keys(record2),
    status: record2.status,
    toolsInNativeStatus: Array.isArray(record2.tools) ? record2.tools.map((tool) => tool.name).filter(Boolean) : null
  });
  if (record2.status && typeof record2.status === "object" && record2.status.status === "connected") {
    await host.waitForTodoMcp(process.cwd());
    report.waitForTodoMcpPassedAfterWarmup = true;
  }
} catch (error) {
  Object.assign(report, { phase: "failed", error: error instanceof Error ? error.message.slice(0, 800) : String(error).slice(0, 800) });
} finally {
  await host.dispose();
  Object.assign(report, { isolatedHostDisposed: true });
  await rm(temporary, { recursive: true, force: true });
  await writeFile(join(process.cwd(), ".artifacts/todo-mcp-all-agents-20261118/opencode-readonly-probe.json"), JSON.stringify(report, null, 2) + `
`);
  console.log(JSON.stringify(report));
}
