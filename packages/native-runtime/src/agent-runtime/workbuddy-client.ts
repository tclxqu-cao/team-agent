import { randomUUID } from "node:crypto";
import type { AgentEvent } from "@agent/core";
import { AsyncEventQueue } from "./async-event-queue.js";
import { parseImageDataUrls } from "./image-input.js";
import { resolveNativeCliCommand } from "./native-cli-command.js";
import { nativeRecord } from "./native-rpc-client.js";
import { NativeStdioChannel, type NativeJsonPacket, type NativeStdioCommand } from "./native-stdio-channel.js";
import type { NativeProtocolSession, NativeSessionProtocol } from "./stdio-native-runtime-adapter.js";
import { WorkBuddySessionCatalog, workBuddyText } from "./workbuddy-session-catalog.js";
import { RuntimeSessionError, type CreateRuntimeSessionOptions, type RuntimeModelInfo, type RuntimeQuestionAnswer, type RuntimeRunOptions } from "./types.js";

interface Run {
  channel: NativeStdioChannel;
  queue: AsyncEventQueue<AgentEvent>;
  text: string;
  messageText: string;
  reasoningScope: string;
  messageOrdinal: number;
  aborted: boolean;
  finished: boolean;
  nativeFailure?: Extract<AgentEvent, { type: "error" }>;
  toolIds: Set<string>;
  blocks: Map<number, { id: string; name: string; input: string }>;
}

interface Permission {
  sessionId: string;
  requestId: string;
  input: NativeJsonPacket;
  question?: string;
  options?: Array<{ label: string; description: string }>;
}

interface Options {
  catalog?: Pick<WorkBuddySessionCatalog, "list" | "read">;
  command?: () => Promise<NativeStdioCommand>;
}

function nativeAuthenticationFailure(message: NativeJsonPacket, text: string): Run["nativeFailure"] {
  const usage = nativeRecord(message.usage);
  if (message.model !== "unknown" || message.stop_reason !== null || usage.input_tokens !== 0 || usage.output_tokens !== 0) return;
  // Some native versions wrap these local, zero-token failures in success packets.
  const notice = text.trim();
  if (notice === "Authentication required. Please use /login command to sign in to your account") return { type: "error", code: "AUTHENTICATION_REQUIRED", message: notice };
  if (notice === "Authentication failed. Please use /login command to sign in to your account") return { type: "error", code: "AUTHENTICATION_FAILED", message: notice };
}

/** WorkBuddy stream-json is not ACP: response correlation is nested under response. */
export class WorkBuddyClient implements NativeSessionProtocol {
  private readonly catalog: Pick<WorkBuddySessionCatalog, "list" | "read">;
  private readonly command: () => Promise<NativeStdioCommand>;
  private readonly drafts = new Map<string, NativeProtocolSession>();
  private readonly runs = new Map<string, Run>();
  private readonly permissions = new Map<string, Permission>();

  constructor(options: Options = {}) {
    this.catalog = options.catalog ?? new WorkBuddySessionCatalog();
    this.command = options.command ?? (() => resolveNativeCliCommand("workbuddy"));
  }

  private channel(command: NativeStdioCommand, id?: string): NativeStdioChannel {
    return new NativeStdioChannel({ ...command,
      responseKey: packet => packet.type === "control_response" && typeof nativeRecord(packet.response).request_id === "string"
        ? String(nativeRecord(packet.response).request_id) : undefined,
      onPacket: packet => id ? this.packet(id, packet) : undefined,
      onFailure: error => {
        const run = id ? this.runs.get(id) : undefined;
        if (!run || run.finished) return;
        this.finish(id!, run.aborted ? { type: "turn_aborted" } : { type: "error", message: error.message, code: error.code });
      },
    });
  }

  private async control(channel: NativeStdioChannel, subtype: string, request: NativeJsonPacket = {}): Promise<NativeJsonPacket> {
    const requestId = randomUUID();
    const packet = await channel.request(requestId, { type: "control_request", request_id: requestId, request: { subtype, ...request } });
    const response = nativeRecord(packet.response);
    if (response.subtype !== "success") throw new RuntimeSessionError(typeof response.error === "string" ? response.error : "WorkBuddy control request failed", "NATIVE_PROTOCOL_ERROR");
    return nativeRecord(response.response);
  }

  async available(): Promise<void> {
    if (!(await this.metadata()).authenticated) throw new RuntimeSessionError("WorkBuddy CLI requires native login; sign in using the installed CLI", "RUNTIME_UNAVAILABLE");
  }

  private async metadata(): Promise<{ models: RuntimeModelInfo[]; authenticated: boolean }> {
    const channel = this.channel(await this.command());
    try {
      const result = await this.control(channel, "initialize");
      // initialize also returns a native account/token: never retain or expose it.
      const account = nativeRecord(result.account);
      const models = Array.isArray(result.models) ? result.models.flatMap(value => {
        const model = nativeRecord(value);
        return typeof model.id === "string" ? [{ id: model.id, displayName: typeof model.name === "string" ? model.name : model.id,
          description: typeof model.description === "string" ? model.description : undefined }] : [];
      }) : [];
      return { models, authenticated: typeof account.uid === "string" || typeof account.uid === "number" || typeof account.userId === "string" || typeof account.userId === "number" };
    } finally { await channel.dispose(); }
  }

  async listModels(): Promise<RuntimeModelInfo[]> { return (await this.metadata()).models; }

  list() { return this.catalog.list(); }

  async read(id: string) {
    try { return await this.catalog.read(id); }
    catch (error) {
      const draft = this.drafts.get(id);
      if (!(error instanceof RuntimeSessionError) || error.code !== "SESSION_NOT_FOUND" || !draft) throw error;
      return { session: draft, messages: [] };
    }
  }

  async create(options: CreateRuntimeSessionOptions): Promise<NativeProtocolSession> {
    await this.command();
    const now = new Date().toISOString();
    const session = { id: randomUUID(), title: options.title, cwd: options.cwd, created: now, updated: now };
    this.drafts.set(session.id, session);
    return session;
  }

  restoreDraft(session: NativeProtocolSession): void { this.drafts.set(session.id, { ...session }); }

  async *run(id: string, input: string, images?: string[], options?: RuntimeRunOptions): AsyncIterable<AgentEvent> {
    if (this.runs.has(id)) throw new RuntimeSessionError("WorkBuddy session is already running", "SESSION_ALREADY_RUNNING");
    const native = (await this.catalog.list()).find(session => session.id === id);
    const session = native ?? this.drafts.get(id);
    if (!session) throw new RuntimeSessionError("WorkBuddy session not found", "SESSION_NOT_FOUND");
    if (native?.running) throw new RuntimeSessionError("WorkBuddy session is owned by another process", "SESSION_OCCUPIED");
    if (options?.reasoningEffort) throw new RuntimeSessionError("WorkBuddy model effort is not advertised by its native model list", "OPERATION_NOT_SUPPORTED");
    const content: NativeJsonPacket[] = [{ type: "text", text: input }, ...parseImageDataUrls(images).map(image => ({ type: "image", source: { type: "base64", media_type: image.mimeType, data: image.base64 } }))];
    const command = await this.command();
    command.cwd = session.cwd;
    command.args = [...command.args ?? [], native ? "--resume" : "--session-id", id, ...(options?.model ? ["--model", options.model.id] : [])];
    const channel = this.channel(command, id);
    const run: Run = { channel, queue: new AsyncEventQueue(), text: "", messageText: "", reasoningScope: randomUUID(), messageOrdinal: 0, aborted: false, finished: false, toolIds: new Set(), blocks: new Map() };
    this.runs.set(id, run);
    try {
      await this.control(channel, "initialize");
      await channel.send({ type: "user", session_id: id, uuid: randomUUID(), parent_tool_use_id: null, message: { role: "user", content } });
      yield* run.queue;
    } finally {
      run.finished = true; run.queue.close();
      this.runs.delete(id);
      for (const [questionId, pending] of this.permissions) if (pending.sessionId === id) this.permissions.delete(questionId);
      await channel.dispose();
    }
  }

  private finish(id: string, event: AgentEvent): void {
    const run = this.runs.get(id);
    if (!run || run.finished) return;
    run.finished = true;
    for (const [questionId, pending] of this.permissions) if (pending.sessionId === id) {
      this.permissions.delete(questionId); run.queue.push({ type: "approval_resolved", questionId });
    }
    run.queue.push(event); run.queue.close();
  }

  private tool(run: Run, part: NativeJsonPacket): void {
    if (typeof part.id !== "string" || run.toolIds.has(part.id)) return;
    run.toolIds.add(part.id);
    run.queue.push({ type: "tool_call", toolCall: { id: part.id, name: String(part.name ?? "WorkBuddy tool"), arguments: nativeRecord(part.input) } });
  }

  private packet(id: string, packet: NativeJsonPacket): void {
    const run = this.runs.get(id);
    if (!run || run.finished) return;
    if (typeof packet.session_id === "string" && packet.session_id !== id) return;
    if (packet.type === "control_request") {
      const request = nativeRecord(packet.request);
      if (request.subtype !== "can_use_tool" || typeof packet.request_id !== "string") {
        if (typeof packet.request_id === "string") void run.channel.send({ type: "control_response", response: { subtype: "error", request_id: packet.request_id, error: "Unsupported native request" } }).catch(() => {});
        return;
      }
      const questionId = `workbuddy-permission:${randomUUID()}`;
      const input = nativeRecord(request.input);
      const question = Array.isArray(input.questions) ? nativeRecord(input.questions[0]) : {};
      const isQuestion = (request.tool_name === "AskUserQuestion" || request.tool_name === "AskUserForStructuredInput")
        && Array.isArray(input.questions) && input.questions.length === 1 && typeof question.question === "string";
      const options = isQuestion && Array.isArray(question.options) ? question.options.map(value => {
        const option = nativeRecord(value); return { label: String(option.label ?? option.value ?? ""), description: String(option.description ?? "") };
      }) : undefined;
      this.permissions.set(questionId, { sessionId: id, requestId: packet.request_id, input, question: isQuestion ? String(question.question) : undefined, options });
      run.queue.push({ type: "ask_user", questionId, question: isQuestion ? String(question.question) : `WorkBuddy: ${String(request.tool_name ?? "tool")} requests permission`,
        options: options?.length ? options : isQuestion ? undefined : [{ label: "Allow once", description: "Approve only this native tool request" }, { label: "Deny", description: "Do not run this tool" }] });
    } else if (packet.type === "control_cancel_request" && typeof packet.request_id === "string") {
      for (const [questionId, pending] of this.permissions) if (pending.requestId === packet.request_id) {
        this.permissions.delete(questionId); run.queue.push({ type: "approval_resolved", questionId });
      }
    } else if (packet.type === "stream_event") {
      const event = nativeRecord(packet.event);
      const delta = nativeRecord(event.delta);
      const block = nativeRecord(event.content_block);
      const index = typeof event.index === "number" ? event.index : 0;
      if (event.type === "message_start") run.messageOrdinal += 1;
      if (event.type === "content_block_start" && block.type === "tool_use" && typeof block.id === "string") run.blocks.set(index, { id: block.id, name: String(block.name), input: "" });
      if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") { const tool = run.blocks.get(index); if (tool) tool.input += delta.partial_json; }
      if (event.type === "content_block_stop") {
        const tool = run.blocks.get(index);
        if (tool) {
          let input: NativeJsonPacket = {}; try { input = nativeRecord(JSON.parse(tool.input || "{}")); } catch { /* Native assistant packet can supply the complete input. */ }
          this.tool(run, { id: tool.id, name: tool.name, input }); run.blocks.delete(index);
        }
      }
      if (delta.type === "text_delta" && typeof delta.text === "string") { run.text += delta.text; run.messageText += delta.text; run.queue.push({ type: "text_chunk", text: delta.text }); }
      if (delta.type === "thinking_delta" && typeof delta.thinking === "string") run.queue.push({ type: "reasoning_summary_delta", itemId: `${run.reasoningScope}:${run.messageOrdinal}:thinking:${index}`, sectionIndex: 0, delta: delta.thinking });
    } else if (packet.type === "assistant") {
      const message = nativeRecord(packet.message);
      const text = workBuddyText(message.content);
      run.nativeFailure = nativeAuthenticationFailure(message, text);
      const suffix = text.startsWith(run.messageText) ? text.slice(run.messageText.length) : run.messageText ? "" : text;
      if (suffix) { run.text += suffix; run.queue.push({ type: "text_chunk", text: suffix }); }
      run.messageText = "";
      run.messageOrdinal += 1;
      if (Array.isArray(message.content)) for (const part of message.content.map(nativeRecord)) if (part.type === "tool_use") this.tool(run, part);
    } else if (packet.type === "user") {
      const content = nativeRecord(packet.message).content;
      if (Array.isArray(content)) for (const part of content.map(nativeRecord)) if (part.type === "tool_result" && typeof part.tool_use_id === "string") {
        run.queue.push({ type: "tool_result", result: { toolCallId: part.tool_use_id, content: workBuddyText(part.content), isError: part.is_error === true } });
      }
    } else if (packet.type === "result") {
      if (run.aborted || typeof packet.terminal_reason === "string" && packet.terminal_reason.startsWith("aborted")) this.finish(id, { type: "turn_aborted" });
      else if (packet.is_error === true || packet.subtype !== "success") this.finish(id, { type: "error", message: Array.isArray(packet.errors) ? packet.errors.map(String).join("\n") : "WorkBuddy execution failed" });
      else if (run.nativeFailure) this.finish(id, run.nativeFailure);
      else {
        if (!run.text && typeof packet.result === "string" && packet.result) { run.text = packet.result; run.queue.push({ type: "text_chunk", text: packet.result }); }
        this.finish(id, { type: "done", finalText: run.text });
      }
    }
  }

  async answerQuestion(id: string, answer: RuntimeQuestionAnswer): Promise<boolean> {
    const pending = this.permissions.get(id);
    if (!pending) return false;
    const run = this.runs.get(pending.sessionId);
    if (!run) return false;
    const index = answer.selectedIndices?.length === 1 ? answer.selectedIndices[0] : pending.options?.findIndex(option => option.label === answer.answer);
    const text = index !== undefined && index >= 0 ? pending.options?.[index]?.label ?? answer.answer : answer.answer;
    let response: NativeJsonPacket;
    if (pending.question) response = { behavior: "allow", updatedInput: { ...pending.input, answers: { [pending.question]: text } } };
    else if (index === 0 || answer.answer === "Allow once") response = { behavior: "allow", updatedInput: pending.input };
    else if (index === 1 || answer.answer === "Deny") response = { behavior: "deny", message: "Denied by user" };
    else throw new RuntimeSessionError("Select Allow once or Deny", "QUESTION_ANSWER_FAILED");
    await run.channel.send({ type: "control_response", response: { subtype: "success", request_id: pending.requestId, response } });
    this.permissions.delete(id); run.queue.push({ type: "approval_resolved", questionId: id });
    return true;
  }

  async abort(id: string): Promise<void> {
    const run = this.runs.get(id);
    if (!run || run.finished) return;
    run.aborted = true;
    try { await this.control(run.channel, "interrupt", { session_id: id }); }
    finally { if (!run.finished) { this.finish(id, { type: "turn_aborted" }); await run.channel.dispose(); } }
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.runs.keys()].map(id => this.abort(id)));
  }
}
