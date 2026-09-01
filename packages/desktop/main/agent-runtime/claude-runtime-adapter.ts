import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import {
  getSessionMessages,
  listSessions,
  query,
  type CanUseTool,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKSessionInfo,
  type SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent, Message, ToolCall } from "@agent/core";
import { AsyncEventQueue } from "./async-event-queue.js";
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
const PAGE_SIZE = 200;

interface PendingPermission {
  input: Record<string, unknown>;
  suggestions?: Parameters<CanUseTool>[2]["suggestions"];
  resolve: (result: PermissionResult) => void;
}

interface ClaudeAgentRecord {
  sessionId?: string;
  state?: string;
  status?: string;
}

export class ClaudeRuntimeAdapter implements AgentRuntimeAdapter {
  readonly agentType = "claude-code" as const;
  private readonly sessionRoot: string;
  private readonly drafts = new Map<string, UnifiedSessionSummary>();
  private readonly ownedSessions = new Set<string>();
  private readonly activeQueries = new Map<string, Query>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();

  constructor(options: { sessionRoot?: string } = {}) {
    this.sessionRoot = options.sessionRoot ?? join(homedir(), ".claude", "projects");
  }

  async health(): Promise<RuntimeHealth> {
    try {
      const { stdout } = await execFileAsync("claude", ["--version"], {
        encoding: "utf8",
        timeout: 5000,
      });
      return {
        agentType: this.agentType,
        available: true,
        label: "Claude Code",
        version: stdout.trim(),
      };
    } catch (error) {
      return {
        agentType: this.agentType,
        available: false,
        label: "Claude Code",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async discoverSessions(): Promise<UnifiedSessionSummary[]> {
    const [sessions, occupiedIds] = await Promise.all([
      this.listAllSessions(),
      this.externalOccupancy(),
    ]);
    const discovered = sessions.map((session) => this.toSummary(session, occupiedIds));
    const discoveredIds = new Set(discovered.map((session) => session.nativeSessionId));
    for (const draft of this.drafts.values()) {
      if (!discoveredIds.has(draft.nativeSessionId)) discovered.push(draft);
    }
    return discovered;
  }

  async getSession(nativeSessionId: string): Promise<UnifiedSessionDetail> {
    const draft = this.drafts.get(nativeSessionId);
    const [session, history, occupiedIds] = await Promise.all([
      this.findSession(nativeSessionId),
      getSessionMessages(nativeSessionId).catch(() => []),
      this.externalOccupancy(),
    ]);
    if (!session && !draft) {
      throw new RuntimeSessionError(`Claude Code session not found: ${nativeSessionId}`, "SESSION_NOT_FOUND");
    }
    const summary = session ? this.toSummary(session, occupiedIds) : draft!;
    return {
      ...summary,
      messages: claudeHistoryToMessages(history),
      events: [],
    };
  }

  async create(options: CreateRuntimeSessionOptions): Promise<UnifiedSessionSummary> {
    const nativeSessionId = crypto.randomUUID();
    const now = new Date().toISOString();
    const summary: UnifiedSessionSummary = {
      id: encodeUnifiedSessionId(this.agentType, nativeSessionId),
      agentType: this.agentType,
      nativeSessionId,
      title: options.title,
      cwd: options.cwd,
      projectId: options.projectId,
      created: now,
      updated: now,
      status: "idle",
      occupancy: "available",
      sourceLabel: "Claude Code SDK",
      canResume: true,
      canDelete: false,
    };
    this.drafts.set(nativeSessionId, summary);
    return summary;
  }

  async *run(nativeSessionId: string, input: string): AsyncIterable<AgentEvent> {
    if (this.activeQueries.has(nativeSessionId)) {
      throw new RuntimeSessionError("Claude Code session is already running", "SESSION_OCCUPIED");
    }
    const detail = await this.getSession(nativeSessionId);
    if (detail.occupancy === "owned-externally") {
      throw new RuntimeSessionError("Claude Code session is open in another client", "SESSION_OCCUPIED");
    }

    const isDraft = this.drafts.has(nativeSessionId);
    const canUseTool: CanUseTool = (toolName, toolInput, options) =>
      this.requestPermission(nativeSessionId, toolName, toolInput, options);
    const activeQuery = query({
      prompt: input,
      options: {
        cwd: detail.cwd,
        ...(isDraft ? { sessionId: nativeSessionId } : { resume: nativeSessionId }),
        canUseTool,
        includePartialMessages: true,
        permissionMode: "default",
        tools: { type: "preset", preset: "claude_code" },
      },
    });
    this.activeQueries.set(nativeSessionId, activeQuery);
    this.ownedSessions.add(nativeSessionId);
    const permissionQueue = new AsyncEventQueue<AgentEvent>();
    this.permissionEvents.set(nativeSessionId, (event) => permissionQueue.push(event));

    let streamedText = "";
    try {
      const sdkIterator = activeQuery[Symbol.asyncIterator]();
      const permissionIterator = permissionQueue[Symbol.asyncIterator]();
      let sdkNext = sdkIterator.next();
      let permissionNext = permissionIterator.next();
      while (true) {
        const next = await Promise.race([
          sdkNext.then((result) => ({ source: "sdk" as const, result })),
          permissionNext.then((result) => ({ source: "permission" as const, result })),
        ]);
        if (next.source === "permission") {
          if (!next.result.done) yield next.result.value;
          permissionNext = permissionIterator.next();
          continue;
        }
        if (next.result.done) break;
        const message = next.result.value;
        sdkNext = sdkIterator.next();
        const events = claudeSdkMessageToEvents(message, streamedText.length > 0);
        for (const event of events) {
          if (event.type === "text_chunk") streamedText += event.text;
          yield event;
        }
        if (message.type === "system" && message.subtype === "init" && message.session_id !== nativeSessionId) {
          throw new RuntimeSessionError(
            `Claude Code returned unexpected session ID ${message.session_id}`,
            "NATIVE_PROTOCOL_ERROR",
          );
        }
        if (message.type === "result") {
          if (message.subtype === "success" && !message.is_error) {
            yield { type: "done", finalText: message.result || streamedText };
          } else {
            const text = "result" in message && typeof message.result === "string"
              ? message.result
              : "errors" in message && Array.isArray(message.errors)
                ? message.errors.join("\n")
                : "Claude Code run failed";
            yield { type: "error", message: text || "Claude Code run failed" };
          }
        }
      }
      this.drafts.delete(nativeSessionId);
    } catch (error) {
      yield {
        type: "error",
        message: error instanceof Error ? error.message : String(error),
        code: error instanceof RuntimeSessionError ? error.code : "NATIVE_PROTOCOL_ERROR",
      };
    } finally {
      this.rejectPermissionsForSession(nativeSessionId, "Claude Code run ended");
      permissionQueue.close();
      this.permissionEvents.delete(nativeSessionId);
      this.activeQueries.delete(nativeSessionId);
      this.ownedSessions.delete(nativeSessionId);
      activeQuery.close();
    }
  }

  async abort(nativeSessionId: string): Promise<void> {
    const activeQuery = this.activeQueries.get(nativeSessionId);
    if (!activeQuery) return;
    await activeQuery.interrupt().catch(() => undefined);
    activeQuery.close();
  }

  async answerQuestion(questionId: string, answer: RuntimeQuestionAnswer): Promise<boolean> {
    const pending = this.pendingPermissions.get(questionId);
    if (!pending) return false;
    this.pendingPermissions.delete(questionId);
    if (answer.answer === "允许一次" || answer.answer === "本会话允许") {
      pending.resolve({
        behavior: "allow",
        updatedInput: pending.input,
        ...(answer.answer === "本会话允许" && pending.suggestions?.length
          ? { updatedPermissions: pending.suggestions }
          : {}),
      });
    } else {
      pending.resolve({
        behavior: "deny",
        message: answer.answer === "取消" ? "User cancelled the operation" : "User declined the operation",
        interrupt: answer.answer === "取消",
      });
    }
    return true;
  }

  async dispose(): Promise<void> {
    for (const activeQuery of this.activeQueries.values()) activeQuery.close();
    this.activeQueries.clear();
    this.ownedSessions.clear();
    for (const [questionId, pending] of this.pendingPermissions) {
      pending.resolve({ behavior: "deny", message: "Customer Agent is shutting down", interrupt: true });
      this.pendingPermissions.delete(questionId);
    }
  }

  private async listAllSessions(): Promise<SDKSessionInfo[]> {
    const sessions: SDKSessionInfo[] = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const page = await listSessions({ limit: PAGE_SIZE, offset });
      sessions.push(...page);
      if (page.length < PAGE_SIZE) return sessions;
    }
  }

  private async findSession(nativeSessionId: string): Promise<SDKSessionInfo | undefined> {
    let offset = 0;
    while (true) {
      const page = await listSessions({ limit: PAGE_SIZE, offset });
      const found = page.find((session) => session.sessionId === nativeSessionId);
      if (found) return found;
      if (page.length < PAGE_SIZE) return undefined;
      offset += PAGE_SIZE;
    }
  }

  private async externalOccupancy(): Promise<Set<string>> {
    const occupied = new Set<string>();
    const [openFiles, agentRecords] = await Promise.all([
      listOpenSessionFiles("claude", this.sessionRoot),
      listClaudeAgentRecords(),
    ]);
    for (const path of openFiles) {
      const name = basename(path);
      if (name.endsWith(".jsonl")) occupied.add(name.slice(0, -6));
    }
    for (const record of agentRecords) {
      if (!record.sessionId) continue;
      const active = record.state !== "done"
        || record.status === "active"
        || record.status === "running";
      if (active) occupied.add(record.sessionId);
    }
    for (const sessionId of this.ownedSessions) occupied.delete(sessionId);
    return occupied;
  }

  private toSummary(session: SDKSessionInfo, occupiedIds: Set<string>): UnifiedSessionSummary {
    const ownedByUs = this.ownedSessions.has(session.sessionId);
    const occupied = occupiedIds.has(session.sessionId);
    const occupancy = ownedByUs
      ? "owned-by-customer-agent" as const
      : occupied
        ? "owned-externally" as const
        : "available" as const;
    const timestamp = new Date(session.lastModified).toISOString();
    return {
      id: encodeUnifiedSessionId(this.agentType, session.sessionId),
      agentType: this.agentType,
      nativeSessionId: session.sessionId,
      title: (session.customTitle || session.summary || session.firstPrompt || "Claude Code session").trim(),
      cwd: session.cwd || "",
      created: new Date(session.createdAt ?? session.lastModified).toISOString(),
      updated: timestamp,
      status: occupancy === "available" ? "idle" : "running",
      occupancy,
      sourceLabel: "Claude Code CLI",
      canResume: occupancy !== "owned-externally",
      canDelete: false,
    };
  }

  private requestPermission(
    nativeSessionId: string,
    toolName: string,
    input: Record<string, unknown>,
    options: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> {
    const questionId = `claude:${nativeSessionId}:${options.requestId}`;
    return new Promise<PermissionResult>((resolve) => {
      const onAbort = () => {
        this.pendingPermissions.delete(questionId);
        resolve({ behavior: "deny", message: "Operation aborted", interrupt: true });
      };
      if (options.signal.aborted) {
        onAbort();
        return;
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
      this.pendingPermissions.set(questionId, {
        input,
        suggestions: options.suggestions,
        resolve: (result) => {
          options.signal.removeEventListener("abort", onAbort);
          resolve(result);
        },
      });
      // Permission requests arrive while run() is iterating, so surface them as
      // a synthetic SDK event through the same renderer event channel.
      const event: AgentEvent = {
        type: "ask_user",
        questionId,
        question: options.title || options.decisionReason || `Claude Code requests permission to use ${toolName}`,
        options: [
          { label: "允许一次", description: options.description || "Allow this operation once" },
          { label: "本会话允许", description: "Allow the suggested operation for this session" },
          { label: "拒绝", description: "Decline this operation" },
          { label: "取消", description: "Cancel the current operation" },
        ],
      };
      this.permissionEvents.get(nativeSessionId)?.(event);
    });
  }

  private readonly permissionEvents = new Map<string, (event: AgentEvent) => void>();

  private rejectPermissionsForSession(nativeSessionId: string, message: string): void {
    for (const [questionId, pending] of this.pendingPermissions) {
      if (!questionId.startsWith(`claude:${nativeSessionId}:`)) continue;
      pending.resolve({ behavior: "deny", message, interrupt: true });
      this.pendingPermissions.delete(questionId);
    }
  }
}

async function listClaudeAgentRecords(): Promise<ClaudeAgentRecord[]> {
  try {
    const { stdout } = await execFileAsync("claude", ["agents", "--json", "--all"], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const value = JSON.parse(stdout) as unknown;
    return Array.isArray(value) ? value as ClaudeAgentRecord[] : [];
  } catch {
    return [];
  }
}

export function claudeHistoryToMessages(history: SessionMessage[]): Message[] {
  const result: Message[] = [];
  for (const entry of history) {
    if (entry.type !== "user" && entry.type !== "assistant") continue;
    const message = asRecord(entry.message);
    const content = message.content;
    if (entry.type === "assistant") {
      const blocks = Array.isArray(content) ? content : [];
      const text = textFromContent(content);
      const toolCalls = blocks.map(claudeBlockToToolCall).filter((call): call is ToolCall => call !== null);
      if (text || toolCalls.length) {
        result.push({ role: "assistant", content: text, ...(toolCalls.length ? { toolCalls } : {}) });
      }
      continue;
    }

    const blocks = Array.isArray(content) ? content : [];
    const text = textFromContent(content);
    if (text) result.push({ role: "user", content: text });
    for (const block of blocks) {
      const record = asRecord(block);
      if (record.type !== "tool_result" || typeof record.tool_use_id !== "string") continue;
      result.push({
        role: "tool",
        content: textFromContent(record.content),
        toolCallId: record.tool_use_id,
      });
    }
  }
  return result;
}

export function claudeSdkMessageToEvents(message: SDKMessage, hasStreamedText: boolean): AgentEvent[] {
  if (message.type === "stream_event") {
    const event = message.event as unknown as Record<string, unknown>;
    if (event.type === "content_block_delta") {
      const delta = asRecord(event.delta);
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        return [{ type: "text_chunk", text: delta.text }];
      }
    }
    return [];
  }
  if (message.type === "assistant") {
    const events: AgentEvent[] = [];
    const blocks = Array.isArray(message.message.content) ? message.message.content : [];
    if (!hasStreamedText) {
      const text = textFromContent(blocks);
      if (text) events.push({ type: "text_chunk", text });
    }
    for (const block of blocks) {
      const toolCall = claudeBlockToToolCall(block);
      if (toolCall) events.push({ type: "tool_call", toolCall });
    }
    return events;
  }
  if (message.type === "user") {
    const content = message.message.content;
    if (!Array.isArray(content)) return [];
    return content.flatMap((block): AgentEvent[] => {
      const record = asRecord(block);
      if (record.type !== "tool_result" || typeof record.tool_use_id !== "string") return [];
      return [{
        type: "tool_result",
        result: {
          toolCallId: record.tool_use_id,
          content: textFromContent(record.content),
          isError: record.is_error === true,
        },
      }];
    });
  }
  return [];
}

function claudeBlockToToolCall(block: unknown): ToolCall | null {
  const record = asRecord(block);
  if (record.type !== "tool_use" || typeof record.id !== "string" || typeof record.name !== "string") return null;
  return {
    id: record.id,
    name: record.name,
    arguments: asRecord(record.input),
  };
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => {
      if (typeof block === "string") return [block];
      const record = asRecord(block);
      return record.type === "text" && typeof record.text === "string" ? [record.text] : [];
    })
    .join("\n")
    .trim();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
