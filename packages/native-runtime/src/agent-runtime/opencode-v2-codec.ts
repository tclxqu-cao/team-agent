import { openCodeFormQuestion, OPENCODE_QUESTION_ASKED, OPENCODE_QUESTION_RESOLVED } from "./opencode-questions.js";

// OpenCode 2 wire records are converted here to the existing adapter's SDK port.
export type OpenCodeRecord = Record<string, unknown>;

export function record(value: unknown): OpenCodeRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid OpenCode 2 object response");
  }
  return value as OpenCodeRecord;
}

export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Invalid OpenCode 2 list response");
  return value;
}

function optionalRecord(value: unknown): OpenCodeRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? record(value) : {};
}

export function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const error = optionalRecord(value);
  return typeof error.message === "string" ? error.message : JSON.stringify(value ?? "OpenCode failed");
}

export function v2Session(value: unknown): OpenCodeRecord {
  const session = record(value);
  const location = record(session.location);
  if (typeof session.id !== "string" || typeof location.directory !== "string") {
    throw new Error("Invalid OpenCode 2 session identity");
  }
  const fork = optionalRecord(session.fork);
  return { ...session, parentID: session.parentID ?? fork.sessionID,
    directory: location.directory, title: session.title ?? "新会话", version: "2" };
}

function contentText(value: unknown): string {
  return array(value ?? []).map((item) => {
    const content = record(item);
    return content.type === "text" ? String(content.text ?? "") : "";
  }).filter(Boolean).join("\n");
}

export function v2Tool(value: unknown, sessionID: string, messageID: string): OpenCodeRecord {
  const tool = record(value);
  const state = record(tool.state);
  const time = optionalRecord(tool.time);
  const status = state.status === "streaming" ? "pending" : state.status;
  const input = typeof state.input === "string" ? { raw: state.input } : optionalRecord(state.input);
  return {
    id: `${messageID}:tool:${tool.id}`, sessionID, messageID,
    type: "tool", callID: tool.id, tool: tool.name,
    state: {
      ...state, status, input, title: tool.name, metadata: optionalRecord(state.metadata),
      ...(status === "completed" ? { output: contentText(state.content) } : {}),
      ...(status === "error" ? { error: errorText(state.error) } : {}),
      time: { start: time.ran ?? time.created ?? 0, end: time.completed ?? 0 },
    },
  };
}

export function v2Message(value: unknown, sessionID: string): OpenCodeRecord | null {
  const message = record(value);
  if (message.type !== "user" && message.type !== "assistant" && message.type !== "synthetic") return null;
  if (typeof message.id !== "string") throw new Error("Invalid OpenCode 2 message identity");
  const messageID = message.id;
  const parts: OpenCodeRecord[] = [];
  const base = { sessionID, messageID };
  if (message.type === "assistant") {
    array(message.content).forEach((item, index) => {
      const content = record(item);
      if (content.type === "tool") parts.push(v2Tool(content, sessionID, messageID));
      else if (content.type === "text" || content.type === "reasoning") {
        const time = optionalRecord(content.time);
        parts.push({ ...base, id: `${sessionID}:${messageID}:${content.type}:${index}`, type: content.type,
          text: content.text, time: { start: time.created ?? 0, end: time.completed } });
      }
    });
  } else {
    parts.push({ ...base, id: `${messageID}:text`, type: "text", text: message.text ?? "" });
    array(message.files ?? []).forEach((item, index) => {
      const file = record(item);
      const url = String(file.uri ?? "");
      parts.push({ ...base, id: `${messageID}:file:${index}`, type: "file", url,
        mime: /^data:([^;,]+)/.exec(url)?.[1] ?? "application/octet-stream", filename: file.name });
    });
  }
  const model = optionalRecord(message.model);
  return { info: { ...message, sessionID, role: message.type === "assistant" ? "assistant" : "user",
    modelID: model.id, providerID: model.providerID }, parts };
}

export const OPENCODE_INTERRUPTED_EVENT = "agentroam:opencode-interrupted";

/** Keeps text/tool state only until the execution's authoritative terminal event. */
export class OpenCodeV2EventCodec {
  private readonly text = new Map<string, string>();
  private readonly tools = new Map<string, OpenCodeRecord>();
  constructor(private readonly directories: Map<string, string>) {}

  convert(value: unknown): OpenCodeRecord[] {
    const event = record(value);
    const data = optionalRecord(event.data);
    const type = String(event.type ?? "");
    const form = type === "form.created" ? optionalRecord(data.form) : data;
    const sessionID = typeof form.sessionID === "string" ? form.sessionID : undefined;
    if (!sessionID) return [];
    const location = optionalRecord(event.location);
    const directory = typeof location.directory === "string" ? location.directory : this.directories.get(sessionID);
    if (!directory) return [];
    this.directories.set(sessionID, directory);
    const emit = (type: string, properties: OpenCodeRecord) => [{ directory, payload: { type, properties } }];
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
      if (type === "session.tool.called") tool.state = { status: "running", input: data.input, metadata: {} };
      else if (type === "session.tool.progress") tool.state = { ...previous, metadata: data.metadata };
      else if (type === "session.tool.success") tool.state = { ...previous, status: "completed", content: data.content, metadata: data.metadata };
      else if (type === "session.tool.failed") tool.state = { ...previous, status: "error", error: data.error, metadata: data.metadata };
      else return [];
      this.tools.set(key, tool);
      return emit("message.part.updated", { part: v2Tool(tool, sessionID, messageID) });
    }
    if (type === "permission.asked") {
      const metadata = optionalRecord(data.metadata);
      const files = Array.isArray(metadata.files) ? metadata.files.map(optionalRecord) : [];
      const patches = files.map((file) => file.patch).filter((patch): patch is string => typeof patch === "string");
      return emit(type, { ...data, permission: data.action === "shell" ? "bash" : data.action,
        patterns: data.resources, metadata: { ...metadata,
          ...(files.length > 0 && patches.length === files.length ? { diff: patches.join("\n") } : {}) },
      });
    }
    if (type === "permission.replied") return emit(type, data);
    if (type === "session.retry.scheduled") {
      return emit("session.status", { sessionID, status: { type: "retry", attempt: data.attempt, message: errorText(data.error), next: data.at } });
    }
    if (type.startsWith("session.execution.") && type !== "session.execution.started") {
      for (const key of this.text.keys()) if (key.startsWith(`${sessionID}:`)) this.text.delete(key);
      for (const key of this.tools.keys()) if (key.startsWith(`${sessionID}:`)) this.tools.delete(key);
      if (type === "session.execution.failed") return emit("session.error", { sessionID, error: { message: errorText(data.error) } });
      if (type === "session.execution.interrupted") return emit(OPENCODE_INTERRUPTED_EVENT, { sessionID });
      if (type === "session.execution.succeeded") return emit("session.idle", { sessionID });
    }
    return [];
  }
}
