import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentEvent, Message, ToolCall } from "@agent/core";
import { AsyncEventQueue } from "./async-event-queue.js";
import {
  CodexAppServerClient,
  type RpcId,
  type RpcNotification,
  type RpcServerRequest,
} from "./codex-app-server-client.js";
import { listOpenSessionFiles } from "./native-processes.js";
import { encodeUnifiedSessionId } from "./session-id.js";
import type {
  AgentRuntimeAdapter,
  CreateRuntimeSessionOptions,
  RuntimeHealth,
  RuntimeQuestionAnswer,
  UnifiedSessionDetail,
  UnifiedSessionSummary,
} from "./types.js";
import { RuntimeSessionError } from "./types.js";

const execFileAsync = promisify(execFile);

interface CodexThread {
  id: string;
  parentThreadId: string | null;
  preview: string;
  name: string | null;
  createdAt: number;
  updatedAt: number;
  status: { type: string; activeFlags?: string[] };
  path: string | null;
  cwd: string;
  source: unknown;
  turns: CodexTurn[];
}

interface CodexTurn {
  id: string;
  status: string;
  items: CodexItem[];
  error?: { message?: string } | null;
}

type CodexItem = Record<string, unknown> & { type: string; id?: string };

interface PendingApproval {
  requestId: RpcId;
  method: string;
  params: Record<string, unknown>;
}

export class CodexRuntimeAdapter implements AgentRuntimeAdapter {
  readonly agentType = "codex" as const;
  private readonly client: CodexAppServerClient;
  private readonly sessionRoot: string;
  private readonly activeQueues = new Map<string, AsyncEventQueue<AgentEvent>>();
  private readonly activeTurnIds = new Map<string, string>();
  private readonly ownedThreads = new Set<string>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();

  constructor(options: { client?: CodexAppServerClient; sessionRoot?: string } = {}) {
    this.client = options.client ?? new CodexAppServerClient();
    this.sessionRoot = options.sessionRoot ?? join(homedir(), ".codex", "sessions");
    this.client.onNotification((message) => this.handleNotification(message));
    this.client.setServerRequestHandler((message) => this.handleServerRequest(message));
  }

  async health(): Promise<RuntimeHealth> {
    try {
      const { stdout } = await execFileAsync("codex", ["--version"], { encoding: "utf8", timeout: 5000 });
      return { agentType: this.agentType, available: true, label: "Codex", version: stdout.trim() };
    } catch (error) {
      return {
        agentType: this.agentType,
        available: false,
        label: "Codex",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async discoverSessions(): Promise<UnifiedSessionSummary[]> {
    const openFiles = await listOpenSessionFiles("codex", this.sessionRoot, {
      excludePids: this.client.pid ? [this.client.pid] : [],
    });
    const threads: CodexThread[] = [];
    let cursor: string | null = null;
    do {
      const response: {
        data: CodexThread[];
        nextCursor: string | null;
      } = await this.client.request("thread/list", {
        cursor,
        limit: 200,
        sortKey: "updated_at",
        sortDirection: "desc",
      });
      threads.push(...response.data);
      cursor = response.nextCursor;
    } while (cursor);
    return threads.map((thread) => this.toSummary(thread, openFiles));
  }

  async getSession(nativeSessionId: string): Promise<UnifiedSessionDetail> {
    const response = await this.client.request<{ thread: CodexThread }>("thread/read", {
      threadId: nativeSessionId,
      includeTurns: true,
    });
    const openFiles = await listOpenSessionFiles("codex", this.sessionRoot, {
      excludePids: this.client.pid ? [this.client.pid] : [],
    });
    return {
      ...this.toSummary(response.thread, openFiles),
      messages: codexTurnsToMessages(response.thread.turns),
      events: [],
    };
  }

  async create(options: CreateRuntimeSessionOptions): Promise<UnifiedSessionSummary> {
    const response = await this.client.request<{ thread: CodexThread }>("thread/start", {
      cwd: options.cwd,
      threadSource: "customer-agent",
    });
    await this.client.request("thread/name/set", {
      threadId: response.thread.id,
      name: options.title,
    }).catch(() => undefined);
    await this.client.request("thread/unsubscribe", { threadId: response.thread.id }).catch(() => undefined);
    return this.toSummary(
      { ...response.thread, name: options.title },
      new Set(),
    );
  }

  async *run(nativeSessionId: string, input: string): AsyncIterable<AgentEvent> {
    if (this.activeQueues.has(nativeSessionId)) {
      throw new RuntimeSessionError("Codex session is already running", "SESSION_OCCUPIED");
    }
    const detail = await this.getSession(nativeSessionId);
    if (detail.occupancy === "owned-externally") {
      throw new RuntimeSessionError("Codex session is open in another client", "SESSION_OCCUPIED");
    }

    const queue = new AsyncEventQueue<AgentEvent>();
    this.activeQueues.set(nativeSessionId, queue);
    this.ownedThreads.add(nativeSessionId);
    try {
      await this.client.request("thread/resume", {
        threadId: nativeSessionId,
        excludeTurns: true,
      });
      const response = await this.client.request<{ turn: { id: string } }>("turn/start", {
        threadId: nativeSessionId,
        input: [{ type: "text", text: input, text_elements: [] }],
      });
      this.activeTurnIds.set(nativeSessionId, response.turn.id);
      for await (const event of queue) yield event;
    } catch (error) {
      const normalized = normalizeCodexError(error);
      yield { type: "error", message: normalized.message, code: normalized.code };
    } finally {
      this.activeTurnIds.delete(nativeSessionId);
      this.activeQueues.delete(nativeSessionId);
      this.ownedThreads.delete(nativeSessionId);
      await this.client.request("thread/unsubscribe", { threadId: nativeSessionId }).catch(() => undefined);
    }
  }

  async abort(nativeSessionId: string): Promise<void> {
    const turnId = this.activeTurnIds.get(nativeSessionId);
    if (!turnId) return;
    await this.client.request("turn/interrupt", { threadId: nativeSessionId, turnId });
  }

  async answerQuestion(questionId: string, answer: RuntimeQuestionAnswer): Promise<boolean> {
    const pending = this.pendingApprovals.get(questionId);
    if (!pending) return false;
    this.pendingApprovals.delete(questionId);
    const value = answer.answer.trim();
    if (pending.method === "item/tool/requestUserInput") {
      const questions = pending.params.questions as Array<{ id: string }> | undefined;
      this.client.respond(pending.requestId, {
        answers: Object.fromEntries((questions ?? []).map((question) => [
          question.id,
          { answers: [value] },
        ])),
      });
      return true;
    }

    const decision = value === "本会话允许"
      ? "acceptForSession"
      : value === "允许一次"
        ? "accept"
        : value === "取消"
          ? "cancel"
          : "decline";
    this.client.respond(pending.requestId, { decision });
    return true;
  }

  async dispose(): Promise<void> {
    await this.client.dispose();
  }

  private toSummary(thread: CodexThread, openFiles: Set<string>): UnifiedSessionSummary {
    const ownedByUs = this.ownedThreads.has(thread.id);
    const heldOpen = Boolean(thread.path && openFiles.has(thread.path));
    const occupancy = ownedByUs
      ? "owned-by-customer-agent" as const
      : heldOpen
        ? "owned-externally" as const
        : "available" as const;
    return {
      id: encodeUnifiedSessionId(this.agentType, thread.id),
      agentType: this.agentType,
      nativeSessionId: thread.id,
      title: (thread.name || thread.preview || "Codex session").trim(),
      cwd: thread.cwd,
      parentSessionId: thread.parentThreadId
        ? encodeUnifiedSessionId(this.agentType, thread.parentThreadId)
        : undefined,
      created: new Date(thread.createdAt * 1000).toISOString(),
      updated: new Date(thread.updatedAt * 1000).toISOString(),
      status: occupancy === "available" ? "idle" : "running",
      occupancy,
      sourceLabel: codexSourceLabel(thread.source),
      canResume: occupancy !== "owned-externally",
      canDelete: false,
    };
  }

  private handleNotification(message: RpcNotification): void {
    const params = message.params ?? {};
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    if (!threadId) return;
    const queue = this.activeQueues.get(threadId);
    if (!queue) return;

    if (message.method === "item/agentMessage/delta" && typeof params.delta === "string") {
      queue.push({ type: "text_chunk", text: params.delta });
      return;
    }
    if (message.method === "item/started") {
      const toolCall = codexItemToToolCall(params.item as CodexItem | undefined);
      if (toolCall) queue.push({ type: "tool_call", toolCall });
      return;
    }
    if (message.method === "item/completed") {
      const result = codexItemToToolResult(params.item as CodexItem | undefined);
      if (result) queue.push({ type: "tool_result", result });
      return;
    }
    if (message.method === "turn/completed") {
      const turn = params.turn as CodexTurn | undefined;
      if (turn?.status === "failed") {
        queue.push({ type: "error", message: turn.error?.message ?? "Codex turn failed" });
      } else {
        const finalText = lastCodexAgentText(turn?.items ?? []);
        queue.push({ type: "done", finalText });
      }
      queue.close();
      return;
    }
    if (message.method === "error") {
      queue.push({ type: "error", message: String(params.message ?? "Codex runtime error") });
      queue.close();
    }
  }

  private handleServerRequest(message: RpcServerRequest): void {
    const params = message.params ?? {};
    if (message.method === "currentTime/read") {
      this.client.respond(message.id, { currentTime: new Date().toISOString() });
      return;
    }
    const threadId = typeof params.threadId === "string"
      ? params.threadId
      : typeof params.conversationId === "string"
        ? params.conversationId
        : undefined;
    const queue = threadId ? this.activeQueues.get(threadId) : undefined;
    if (!queue) {
      this.client.respondError(message.id, -32601, `Unsupported server request: ${message.method}`);
      return;
    }

    const questionId = `codex:${String(message.id)}`;
    this.pendingApprovals.set(questionId, {
      requestId: message.id,
      method: message.method,
      params,
    });

    if (message.method === "item/tool/requestUserInput") {
      const questions = params.questions as Array<{
        question?: string;
        options?: Array<{ label: string; description?: string }> | null;
      }> | undefined;
      const first = questions?.[0];
      queue.push({
        type: "ask_user",
        questionId,
        question: first?.question ?? "Codex needs additional input",
        options: first?.options?.map((option) => ({
          label: option.label,
          description: option.description ?? "",
        })),
      });
      return;
    }

    const approvalMethods = new Set([
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "applyPatchApproval",
      "execCommandApproval",
    ]);
    if (!approvalMethods.has(message.method)) {
      this.pendingApprovals.delete(questionId);
      this.client.respondError(message.id, -32601, `Unsupported server request: ${message.method}`);
      return;
    }

    const command = typeof params.command === "string"
      ? params.command
      : Array.isArray(params.command)
        ? params.command.join(" ")
        : undefined;
    const reason = typeof params.reason === "string" ? params.reason : undefined;
    queue.push({
      type: "ask_user",
      questionId,
      question: reason || (command ? `Codex requests permission to run: ${command}` : "Codex requests permission to modify files"),
      options: [
        { label: "允许一次", description: "Allow this operation once" },
        { label: "本会话允许", description: "Allow equivalent operations for this session" },
        { label: "拒绝", description: "Decline this operation" },
        { label: "取消", description: "Cancel the current operation" },
      ],
    });
  }
}

function codexSourceLabel(source: unknown): string {
  if (source === "vscode") return "Codex Desktop";
  if (source === "cli") return "Codex CLI";
  if (source === "exec") return "Codex Exec";
  if (source === "appServer") return "Customer Agent / Codex";
  if (source && typeof source === "object" && "custom" in source) {
    return String((source as { custom: unknown }).custom);
  }
  return "Codex";
}

export function codexTurnsToMessages(turns: CodexTurn[]): Message[] {
  const messages: Message[] = [];
  for (const turn of turns) {
    for (const item of turn.items ?? []) {
      if (item.type === "userMessage") {
        const content = (item.content as Array<Record<string, unknown>> | undefined)
          ?.filter((entry) => entry.type === "text" && typeof entry.text === "string")
          .map((entry) => String(entry.text))
          .join("\n")
          .trim();
        if (content) messages.push({ role: "user", content });
      } else if (item.type === "agentMessage" && typeof item.text === "string" && item.text.trim()) {
        messages.push({ role: "assistant", content: item.text });
      } else {
        const toolCall = codexItemToToolCall(item);
        if (toolCall) messages.push({ role: "assistant", content: "", toolCalls: [toolCall] });
        const result = codexItemToToolResult(item);
        if (result) messages.push({ role: "tool", content: result.content, toolCallId: result.toolCallId, name: toolCall?.name });
      }
    }
  }
  return messages;
}

function codexItemToToolCall(item?: CodexItem): ToolCall | null {
  if (!item?.id) return null;
  if (item.type === "commandExecution") {
    return { id: item.id, name: "shell", arguments: { command: item.command, cwd: item.cwd } };
  }
  if (item.type === "fileChange") {
    return { id: item.id, name: "apply_patch", arguments: { changes: item.changes } };
  }
  if (item.type === "mcpToolCall") {
    return { id: item.id, name: `${String(item.server)}:${String(item.tool)}`, arguments: asRecord(item.arguments) };
  }
  if (item.type === "dynamicToolCall") {
    return { id: item.id, name: String(item.tool), arguments: asRecord(item.arguments) };
  }
  return null;
}

function codexItemToToolResult(item?: CodexItem): { toolCallId: string; content: string; isError?: boolean } | null {
  if (!item?.id) return null;
  if (item.type === "commandExecution") {
    return {
      toolCallId: item.id,
      content: typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : "",
      isError: typeof item.exitCode === "number" && item.exitCode !== 0,
    };
  }
  if (item.type === "fileChange") {
    return { toolCallId: item.id, content: JSON.stringify(item.changes ?? [], null, 2), isError: item.status === "failed" };
  }
  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
    return {
      toolCallId: item.id,
      content: JSON.stringify(item.result ?? item.contentItems ?? item.error ?? {}, null, 2),
      isError: Boolean(item.error) || item.success === false,
    };
  }
  return null;
}

function lastCodexAgentText(items: CodexItem[]): string {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (item.type === "agentMessage" && typeof item.text === "string") return item.text;
  }
  return "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { value };
}

function normalizeCodexError(error: unknown): RuntimeSessionError {
  if (error instanceof RuntimeSessionError) return error;
  return new RuntimeSessionError(
    error instanceof Error ? error.message : String(error),
    "NATIVE_PROTOCOL_ERROR",
  );
}
