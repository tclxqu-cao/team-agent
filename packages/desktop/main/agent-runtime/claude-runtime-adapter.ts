import { execFile } from "node:child_process";
import { open, readFile, readdir, stat, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import {
  getSessionMessages,
  getSubagentMessages,
  listSessions,
  listSubagents,
  query,
  type CanUseTool,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKActiveGoalMessage,
  type SDKSessionInfo,
  type SDKUserMessage,
  type SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  classifyToolPermission,
  normalizeToolPermissionMode,
  type AgentEvent,
  type Message,
  type MessageAttachment,
  type NativeSubagentActivity,
  type ToolCall,
  type ToolPermissionMode,
} from "@agent/core";
import { AsyncEventQueue } from "./async-event-queue.js";
import { parseImageDataUrls } from "./image-input.js";
import { listOpenSessionFiles } from "./native-processes.js";
import { encodeUnifiedSessionId } from "./session-id.js";
import {
  decodeOffsetCursor,
  encodeOffsetCursor,
  paginateByOffset,
  workspacePageSize,
} from "./agent-workspace-index.js";
import type {
  AgentRuntimeAdapter,
  AgentWorkspace,
  CreateRuntimeSessionOptions,
  RuntimeHealth,
  RuntimeQuestionAnswer,
  RuntimeRunOptions,
  UnifiedSessionDetail,
  UnifiedSessionSummary,
  WorkspacePage,
  WorkspaceQuery,
  WorkspaceSessionQuery,
} from "./types.js";
import { RuntimeSessionError } from "./types.js";

const execFileAsync = promisify(execFile);
const PAGE_SIZE = 200;
const TRANSCRIPT_CWD_SCAN_LIMIT = 2 * 1024 * 1024;
const TRANSCRIPT_SCAN_CHUNK_SIZE = 64 * 1024;
const CLAUDE_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface PendingPermission {
  nativeSessionId: string;
  input: Record<string, unknown>;
  suggestions?: Parameters<CanUseTool>[2]["suggestions"];
  resolve: (result: PermissionResult) => void;
}

interface ClaudeAgentRecord {
  sessionId?: string;
  state?: string;
  status?: string;
}

interface ClaudeSubagentMetadata {
  agentType?: string;
  description?: string;
  toolUseId?: string;
  spawnDepth?: number;
}

interface TrackedClaudeSubagent {
  activity: NativeSubagentActivity;
  ambient: boolean;
  settled: boolean;
  streamedText: boolean;
}

export class ClaudeSubagentTracker {
  private readonly tasks = new Map<string, TrackedClaudeSubagent>();

  consume(message: SDKMessage): AgentEvent[] {
    if (message.type === "system" && message.subtype === "task_started") {
      if (
        message.ambient === true
        || message.skip_transcript === true
        || (message.task_type !== "local_agent" && !message.subagent_type)
        || typeof message.tool_use_id !== "string"
      ) return [];
      const tracked: TrackedClaudeSubagent = {
        ambient: false,
        settled: false,
        streamedText: false,
        activity: {
          taskId: message.task_id,
          parentToolCallId: message.tool_use_id,
          agentName: message.subagent_type,
          description: message.description.trim(),
          status: "running",
          isBackgrounded: message.is_backgrounded,
          spawnDepth: message.spawn_depth,
          messages: [],
        },
      };
      this.tasks.set(message.task_id, tracked);
      return [this.update(tracked)];
    }

    if (message.type === "system" && message.subtype === "task_progress") {
      const tracked = this.tasks.get(message.task_id);
      if (!tracked || tracked.ambient) return [];
      tracked.activity = {
        ...tracked.activity,
        description: message.description.trim() || tracked.activity.description,
        agentName: message.subagent_type ?? tracked.activity.agentName,
        summary: message.summary?.trim() || tracked.activity.summary,
        lastToolName: message.last_tool_name ?? tracked.activity.lastToolName,
        elapsedSeconds: finiteSeconds(message.usage.duration_ms),
        toolUses: finiteCount(message.usage.tool_uses),
      };
      return [this.update(tracked)];
    }

    if (message.type === "system" && message.subtype === "task_updated") {
      const tracked = this.tasks.get(message.task_id);
      if (!tracked || tracked.ambient) return [];
      tracked.activity = {
        ...tracked.activity,
        status: message.patch.status ? claudeTaskStatus(message.patch.status) : tracked.activity.status,
        description: message.patch.description?.trim() || tracked.activity.description,
        isBackgrounded: message.patch.is_backgrounded ?? tracked.activity.isBackgrounded,
        summary: message.patch.error?.trim() || tracked.activity.summary,
      };
      return [this.update(tracked)];
    }

    if (message.type === "system" && message.subtype === "task_notification") {
      const tracked = this.tasks.get(message.task_id);
      if (!tracked || tracked.ambient || message.ambient === true || message.skip_transcript === true) return [];
      tracked.activity = {
        ...tracked.activity,
        status: message.status,
        summary: message.summary?.trim() || tracked.activity.summary,
        elapsedSeconds: message.usage ? finiteSeconds(message.usage.duration_ms) : tracked.activity.elapsedSeconds,
        toolUses: message.usage ? finiteCount(message.usage.tool_uses) : tracked.activity.toolUses,
      };
      tracked.settled = true;
      return [this.update(tracked)];
    }

    const parentToolCallId = parentToolUseId(message);
    if (!parentToolCallId) return [];
    const tracked = [...this.tasks.values()].find(
      (candidate) => candidate.activity.parentToolCallId === parentToolCallId && !candidate.ambient,
    );
    if (!tracked) return [];

    if (message.type === "stream_event") {
      const event = message.event as unknown as Record<string, unknown>;
      if (event.type !== "content_block_delta") return [];
      const delta = asRecord(event.delta);
      if (delta.type !== "text_delta" || typeof delta.text !== "string" || !delta.text) return [];
      tracked.activity = {
        ...tracked.activity,
        messages: appendClaudeText(tracked.activity.messages, delta.text),
      };
      tracked.streamedText = true;
      return [this.update(tracked)];
    }

    if (message.type === "assistant") {
      let messages = tracked.activity.messages;
      const blocks = Array.isArray(message.message.content) ? message.message.content : [];
      const text = textFromContent(blocks);
      if (text && !tracked.streamedText) messages = appendClaudeText(messages, text);
      for (const block of blocks) {
        const toolCall = claudeBlockToToolCall(block);
        if (toolCall) messages = appendClaudeToolCall(messages, toolCall);
      }
      tracked.streamedText = false;
      if (messages === tracked.activity.messages) return [];
      tracked.activity = { ...tracked.activity, messages };
      return [this.update(tracked)];
    }

    if (message.type === "user") {
      const content = message.message.content;
      if (!Array.isArray(content)) return [];
      let messages = tracked.activity.messages;
      for (const block of content) {
        const record = asRecord(block);
        if (record.type !== "tool_result" || typeof record.tool_use_id !== "string") continue;
        messages = appendClaudeToolResult(
          messages,
          record.tool_use_id,
          textFromContent(record.content),
          record.is_error === true,
        );
      }
      if (messages === tracked.activity.messages) return [];
      tracked.activity = { ...tracked.activity, messages };
      return [this.update(tracked)];
    }
    return [];
  }

  hasActiveBackgroundTasks(): boolean {
    return [...this.tasks.values()].some(
      ({ activity, ambient, settled }) => !ambient && !settled && activity.isBackgrounded === true,
    );
  }

  stopActive(): AgentEvent[] {
    const events: AgentEvent[] = [];
    for (const tracked of this.tasks.values()) {
      if (tracked.ambient || tracked.settled) continue;
      tracked.activity = { ...tracked.activity, status: "stopped" };
      events.push(this.update(tracked));
    }
    return events;
  }

  private update(tracked: TrackedClaudeSubagent): Extract<AgentEvent, { type: "native_subagent_update" }> {
    return {
      type: "native_subagent_update",
      activity: {
        ...tracked.activity,
        messages: tracked.activity.messages.map((message) => ({
          ...message,
          ...(message.toolCalls ? { toolCalls: message.toolCalls.map((toolCall) => ({ ...toolCall })) } : {}),
        })),
      },
    };
  }
}

export class ClaudeRuntimeAdapter implements AgentRuntimeAdapter {
  readonly agentType = "claude-code" as const;
  private readonly sessionRoot: string;
  private readonly drafts = new Map<string, UnifiedSessionSummary>();
  private readonly workspaces = new Map<string, AgentWorkspace>();
  private readonly ownedSessions = new Set<string>();
  private readonly activeQueries = new Map<string, Query>();
  private readonly activeInputs = new Map<string, AsyncEventQueue<SDKUserMessage>>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly abortedSessions = new Set<string>();

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
    const discovered = await Promise.all(sessions.map(async (session) => {
      const summary = await this.toSummary(session, occupiedIds);
      const draft = this.drafts.get(session.sessionId);
      if (!draft) return summary;
      this.drafts.delete(session.sessionId);
      return mergeClaudeDraftContext(summary, draft);
    }));
    const discoveredIds = new Set(discovered.map((session) => session.nativeSessionId));
    for (const draft of this.drafts.values()) {
      if (!discoveredIds.has(draft.nativeSessionId)) discovered.push(draft);
    }
    return discovered;
  }

  async listWorkspaces(query: WorkspaceQuery = {}): Promise<WorkspacePage<AgentWorkspace>> {
    const sessions = await this.listAllSessions();
    const workspaces: AgentWorkspace[] = [];
    const seen = new Set<string>();
    for (const session of sessions) {
      const cwd = session.cwd?.trim() || await this.readSessionCwd(session.sessionId);
      if (!cwd) continue;
      const workspaceId = claudeWorkspaceId(cwd);
      if (seen.has(workspaceId)) continue;
      seen.add(workspaceId);
      const workspace: AgentWorkspace = {
        agentType: this.agentType,
        workspaceId,
        name: basename(cwd) || cwd,
        roots: [cwd],
        order: workspaces.length,
        updatedAt: new Date(session.lastModified).toISOString(),
        source: "derived",
      };
      this.workspaces.set(workspaceId, workspace);
      workspaces.push(workspace);
    }
    return paginateByOffset(workspaces, query, workspaces[0]?.updatedAt ?? null);
  }

  async listWorkspaceSessions(
    workspaceId: string,
    query: WorkspaceSessionQuery = {},
  ): Promise<WorkspacePage<UnifiedSessionSummary>> {
    let workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      let cursor: string | null = null;
      do {
        const page = await this.listWorkspaces({ cursor, limit: 200, refresh: true });
        workspace = page.data.find((candidate) => candidate.workspaceId === workspaceId);
        cursor = page.nextCursor;
      } while (!workspace && cursor);
    }
    const cwd = workspace?.roots[0];
    if (!cwd) throw new RuntimeSessionError(`Claude Code workspace not found: ${workspaceId}`, "SESSION_NOT_FOUND");
    const page = await this.listWorkspaceSessionsByPath(cwd, query);
    return { ...page, watermark: page.watermark ?? workspace?.updatedAt ?? null };
  }

  async listWorkspaceSessionsByPath(
    cwd: string,
    query: WorkspaceSessionQuery = {},
  ): Promise<WorkspacePage<UnifiedSessionSummary>> {
    const limit = workspacePageSize(query.limit);
    const offset = decodeOffsetCursor(query.cursor);
    const [sessions, occupiedIds] = await Promise.all([
      listSessions({ dir: cwd, limit, offset }),
      this.externalOccupancy(),
    ]);
    const data = await Promise.all(sessions.map((session) => this.toSummary(session, occupiedIds)));
    return {
      data,
      nextCursor: sessions.length === limit ? encodeOffsetCursor(offset + sessions.length) : null,
      watermark: data[0]?.updated ?? null,
    };
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
    const summary = session
      ? mergeClaudeDraftContext(await this.toSummary(session, occupiedIds), draft)
      : draft!;
    const messages = claudeHistoryToMessages(history);
    const events = await this.recoverSubagentActivities(nativeSessionId, summary.cwd, messages);
    return {
      ...summary,
      messages,
      events,
    };
  }

  async getSessionWatchPath(nativeSessionId: string): Promise<string | null> {
    return this.findSessionPath(nativeSessionId);
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

  restoreDraft(summary: UnifiedSessionSummary): void {
    if (
      summary.agentType !== this.agentType
      || !CLAUDE_SESSION_ID.test(summary.nativeSessionId)
      || summary.id !== encodeUnifiedSessionId(this.agentType, summary.nativeSessionId)
      || !summary.cwd.trim()
    ) return;
    this.drafts.set(summary.nativeSessionId, { ...summary });
  }

  async *run(
    nativeSessionId: string,
    input: string,
    images?: string[],
    _agentIds?: string[],
    _agentName?: string,
    runOptions?: RuntimeRunOptions,
  ): AsyncIterable<AgentEvent> {
    if (this.activeQueries.has(nativeSessionId)) {
      throw new RuntimeSessionError("Claude Code session is already running", "SESSION_ALREADY_RUNNING");
    }
    const detail = await this.getSession(nativeSessionId);
    if (detail.occupancy === "owned-externally") {
      throw new RuntimeSessionError("Claude Code session is open in another client", "SESSION_OCCUPIED");
    }
    const effectiveInput = runOptions?.goal
      ? `/goal ${runOptions.goal.objective}`
      : input;
    const initialMessage = claudeUserMessage(effectiveInput, undefined, images);

    const isDraft = this.drafts.has(nativeSessionId);
    const permissionMode = normalizeToolPermissionMode(runOptions?.permissionMode);
    const canUseTool: CanUseTool | undefined = permissionMode === "full-access"
      ? undefined
      : (toolName, toolInput, options) => this.requestPermission(
          nativeSessionId,
          toolName,
          toolInput,
          options,
          permissionMode,
          detail.cwd,
          runOptions?.brokerRunId,
        );
    const inputQueue = new AsyncEventQueue<SDKUserMessage>();
    inputQueue.push(initialMessage);
    const activeQuery = query({
      prompt: inputQueue,
      options: {
        cwd: detail.cwd,
        ...(isDraft ? { sessionId: nativeSessionId } : { resume: nativeSessionId }),
        includePartialMessages: true,
        forwardSubagentText: true,
        agentProgressSummaries: true,
        permissionMode: permissionMode === "full-access" ? "bypassPermissions" : "default",
        ...(permissionMode === "full-access"
          ? { allowDangerouslySkipPermissions: true }
          : { canUseTool }),
        tools: { type: "preset", preset: "claude_code" },
        skills: "all",
      } as Parameters<typeof query>[0]["options"],
    });
    this.activeQueries.set(nativeSessionId, activeQuery);
    this.activeInputs.set(nativeSessionId, inputQueue);
    this.ownedSessions.add(nativeSessionId);
    const permissionQueue = new AsyncEventQueue<AgentEvent>();
    this.permissionEvents.set(nativeSessionId, (event) => permissionQueue.push(event));

    let streamedText = "";
    const subagents = new ClaudeSubagentTracker();
    let mainResult: Extract<SDKMessage, { type: "result" }> | null = null;
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
        if (next.result.done) {
          const aborted = this.abortedSessions.delete(nativeSessionId);
          if (subagents.hasActiveBackgroundTasks()) {
            for (const event of subagents.stopActive()) yield event;
            yield aborted
              ? { type: "turn_aborted" }
              : {
                  type: "error",
                  message: "Claude Code ended before a background subagent completed",
                  code: "NATIVE_PROTOCOL_ERROR",
                };
            mainResult = null;
          } else if (aborted) {
            yield { type: "turn_aborted" };
          }
          break;
        }
        const message = next.result.value;
        sdkNext = sdkIterator.next();
        for (const event of subagents.consume(message)) yield event;
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
          mainResult = message;
        }
        if (mainResult && !subagents.hasActiveBackgroundTasks()) {
          yield claudeResultToEvent(mainResult, streamedText);
          mainResult = null;
          break;
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
      inputQueue.close();
      this.permissionEvents.delete(nativeSessionId);
      this.activeQueries.delete(nativeSessionId);
      this.activeInputs.delete(nativeSessionId);
      this.ownedSessions.delete(nativeSessionId);
      this.abortedSessions.delete(nativeSessionId);
      activeQuery.close();
    }
  }

  async steer(nativeSessionId: string, input: string): Promise<boolean> {
    const inputQueue = this.activeInputs.get(nativeSessionId);
    if (!inputQueue) return false;
    inputQueue.push(claudeUserMessage(input, "now"));
    return true;
  }

  async abort(nativeSessionId: string): Promise<void> {
    const activeQuery = this.activeQueries.get(nativeSessionId);
    if (!activeQuery) return;
    this.abortedSessions.add(nativeSessionId);
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
    for (const inputQueue of this.activeInputs.values()) inputQueue.close();
    this.activeInputs.clear();
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

  private async recoverSubagentActivities(
    nativeSessionId: string,
    cwd: string,
    messages: Message[],
  ): Promise<AgentEvent[]> {
    const parentToolCallIds = new Set(messages.flatMap((message) =>
      (message.toolCalls ?? [])
        .filter((toolCall) => toolCall.name === "Agent")
        .map((toolCall) => toolCall.id),
    ));
    if (parentToolCallIds.size === 0) return [];
    const sessionPath = await this.findSessionPath(nativeSessionId);
    if (!sessionPath) return [];
    const subagentsDirectory = join(dirname(sessionPath), nativeSessionId, "subagents");
    const agentIds = await listSubagents(nativeSessionId, cwd ? { dir: cwd } : undefined).catch(() => []);
    const events = await Promise.all(agentIds.map(async (agentId): Promise<AgentEvent | null> => {
      if (!/^[a-z0-9_-]+$/i.test(agentId)) return null;
      try {
        const metadata = JSON.parse(
          await readFile(join(subagentsDirectory, `agent-${agentId}.meta.json`), "utf8"),
        ) as ClaudeSubagentMetadata;
        if (typeof metadata.toolUseId !== "string" || !parentToolCallIds.has(metadata.toolUseId)) return null;
        if (typeof metadata.description !== "string" || !metadata.description.trim()) return null;
        const transcript = await getSubagentMessages(
          nativeSessionId,
          agentId,
          cwd ? { dir: cwd } : undefined,
        );
        const childMessages = claudeHistoryToMessages(transcript);
        if (childMessages.length === 0) return null;
        const summary = [...childMessages].reverse().find(
          (message) => message.role === "assistant" && message.content.trim(),
        )?.content.trim();
        return {
          type: "native_subagent_update",
          activity: {
            taskId: agentId,
            parentToolCallId: metadata.toolUseId,
            agentName: typeof metadata.agentType === "string" ? metadata.agentType : undefined,
            description: metadata.description.trim(),
            status: summary ? "completed" : "stopped",
            spawnDepth: typeof metadata.spawnDepth === "number" ? metadata.spawnDepth : undefined,
            summary,
            messages: childMessages,
          },
        };
      } catch {
        return null;
      }
    }));
    return events.filter((event): event is AgentEvent => event !== null);
  }

  private async findSessionPath(nativeSessionId: string): Promise<string | null> {
    if (basename(nativeSessionId) !== nativeSessionId || !CLAUDE_SESSION_ID.test(nativeSessionId)) return null;
    let projectDirectories;
    try {
      projectDirectories = await readdir(this.sessionRoot, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const directory of projectDirectories) {
      if (!directory.isDirectory()) continue;
      const candidate = join(this.sessionRoot, directory.name, `${nativeSessionId}.jsonl`);
      try {
        if ((await stat(candidate)).isFile()) return candidate;
      } catch {
        // Continue across project directories; session IDs are globally unique.
      }
    }
    return null;
  }

  private async toSummary(session: SDKSessionInfo, occupiedIds: Set<string>): Promise<UnifiedSessionSummary> {
    const ownedByUs = this.ownedSessions.has(session.sessionId);
    const occupied = occupiedIds.has(session.sessionId);
    const occupancy = ownedByUs
      ? "owned-by-customer-agent" as const
      : occupied
        ? "owned-externally" as const
        : "available" as const;
    const timestamp = new Date(session.lastModified).toISOString();
    const cwd = session.cwd?.trim() || await this.readSessionCwd(session.sessionId);
    return {
      id: encodeUnifiedSessionId(this.agentType, session.sessionId),
      agentType: this.agentType,
      nativeSessionId: session.sessionId,
      title: (session.customTitle || session.summary || session.firstPrompt || "Claude Code session").trim(),
      cwd,
      created: new Date(session.createdAt ?? session.lastModified).toISOString(),
      updated: timestamp,
      status: occupancy === "available" ? "idle" : "running",
      occupancy,
      sourceLabel: "Claude Code CLI",
      canResume: occupancy !== "owned-externally",
      canDelete: false,
    };
  }

  private async readSessionCwd(nativeSessionId: string): Promise<string> {
    const path = await this.findSessionPath(nativeSessionId);
    if (!path) return "";
    let handle: FileHandle | undefined;
    try {
      handle = await open(path, "r");
      const buffer = Buffer.alloc(TRANSCRIPT_SCAN_CHUNK_SIZE);
      const decoder = new StringDecoder("utf8");
      let pending = "";
      let position = 0;
      while (position < TRANSCRIPT_CWD_SCAN_LIMIT) {
        const length = Math.min(buffer.length, TRANSCRIPT_CWD_SCAN_LIMIT - position);
        const { bytesRead } = await handle.read(buffer, 0, length, position);
        if (bytesRead === 0) return cwdFromTranscriptLine(pending + decoder.end());
        position += bytesRead;
        pending += decoder.write(buffer.subarray(0, bytesRead));
        let newline = pending.indexOf("\n");
        while (newline >= 0) {
          const cwd = cwdFromTranscriptLine(pending.slice(0, newline));
          if (cwd) return cwd;
          pending = pending.slice(newline + 1);
          newline = pending.indexOf("\n");
        }
      }
      return cwdFromTranscriptLine(pending + decoder.end());
    } catch {
      return "";
    } finally {
      await handle?.close().catch(() => undefined);
    }
    return "";
  }

  private requestPermission(
    nativeSessionId: string,
    toolName: string,
    input: Record<string, unknown>,
    options: Parameters<CanUseTool>[2],
    permissionMode: ToolPermissionMode,
    cwd: string,
    brokerRunId?: string,
  ): Promise<PermissionResult> {
    const classification = classifyClaudePermission(toolName, input, cwd);
    if (!requiresClaudeApproval(permissionMode, classification)) {
      return Promise.resolve({ behavior: "allow", updatedInput: input });
    }
    const questionId = brokerRunId
      ? `native:${brokerRunId}:${options.requestId}`
      : `claude:${nativeSessionId}:${options.requestId}`;
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
        nativeSessionId,
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
        question: options.title || options.decisionReason || classification.summary || `Claude Code requests permission to use ${toolName}`,
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
      if (pending.nativeSessionId !== nativeSessionId) continue;
      pending.resolve({ behavior: "deny", message, interrupt: true });
      this.pendingPermissions.delete(questionId);
    }
  }
}

function mergeClaudeDraftContext(
  summary: UnifiedSessionSummary,
  draft?: UnifiedSessionSummary,
): UnifiedSessionSummary {
  if (!draft) return summary;
  return {
    ...summary,
    cwd: summary.cwd || draft.cwd,
    projectId: summary.projectId ?? draft.projectId,
  };
}

function cwdFromTranscriptLine(line: string): string {
  if (!line.trim()) return "";
  try {
    const record = JSON.parse(line) as { cwd?: unknown };
    return typeof record.cwd === "string" ? record.cwd.trim() : "";
  } catch {
    return "";
  }
}

export function claudeWorkspaceId(cwd: string): string {
  return `cwd_${Buffer.from(resolve(cwd), "utf8").toString("base64url")}`;
}

export function classifyClaudePermission(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
) {
  const normalizedName = normalizeClaudeToolName(toolName);
  const normalizedInput = normalizeClaudeToolInput(normalizedName, input);
  return classifyToolPermission(normalizedName, normalizedInput, cwd);
}

export function requiresClaudeApproval(
  permissionMode: ToolPermissionMode,
  classification: ReturnType<typeof classifyClaudePermission>,
): boolean {
  if (permissionMode === "full-access") return false;
  if (permissionMode === "request-approval") return classification.kind !== "safe";
  // Auto mode is intentionally narrower for native Claude sessions than the
  // generic local-agent policy: command execution and network access can both
  // cross a privilege boundary even when their inputs look benign.
  return classification.risky || [
    "shell",
    "network",
    "external-write",
    "remote",
    "risky-local",
    "unknown",
  ].includes(classification.kind);
}

function normalizeClaudeToolName(toolName: string): string {
  const compact = toolName.replace(/[^a-z]/gi, "").toLowerCase();
  const names: Record<string, string> = {
    read: "read_file",
    glob: "glob",
    grep: "grep",
    write: "write_file",
    edit: "str_replace",
    multiedit: "str_replace",
    bash: "bash",
    webfetch: "web_fetch",
    websearch: "web_search",
  };
  return names[compact] ?? `claude_${compact || "unknown"}`;
}

function normalizeClaudeToolInput(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
  if ((toolName === "write_file" || toolName === "str_replace") && typeof input.file_path !== "string" && typeof input.path === "string") {
    return { ...input, file_path: input.path };
  }
  return input;
}

function claudeUserMessage(
  input: string,
  priority?: SDKUserMessage["priority"],
  images?: string[],
): SDKUserMessage {
  const parsedImages = parseImageDataUrls(images);
  const content = parsedImages.length > 0
    ? [
        { type: "text" as const, text: input },
        ...parsedImages.map((image) => ({
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: image.mimeType,
            data: image.base64,
          },
        })),
      ]
    : input;
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    ...(priority ? { priority } : {}),
  };
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
    const attachments = claudeImageAttachments(blocks);
    if (text || attachments.length > 0) {
      result.push({
        role: "user",
        content: text,
        ...(attachments.length > 0 ? { presentation: { attachments } } : {}),
      });
    }
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

function claudeImageAttachments(blocks: unknown[]): MessageAttachment[] {
  const attachments: MessageAttachment[] = [];
  for (const block of blocks) {
    const record = asRecord(block);
    if (record.type !== "image") continue;
    const source = asRecord(record.source);
    const mimeType = source.media_type;
    const data = source.data;
    if (source.type !== "base64" || typeof mimeType !== "string" || typeof data !== "string") continue;
    const extension = mimeType === "image/jpeg"
      ? "jpg"
      : mimeType === "image/png"
        ? "png"
        : mimeType === "image/gif"
          ? "gif"
          : mimeType === "image/webp"
            ? "webp"
            : null;
    if (!extension) continue;
    attachments.push({
      type: "image",
      name: `image-${attachments.length + 1}.${extension}`,
      dataUrl: `data:${mimeType};base64,${data}`,
    });
  }
  return attachments;
}

export function claudeSdkMessageToEvents(
  message: SDKMessage | SDKActiveGoalMessage,
  hasStreamedText: boolean,
): AgentEvent[] {
  if (message.type === "active_goal") {
    if (!message.value) return [];
    return [{
      type: "runtime_progress",
      progressId: "claude:goal",
      phase: "status",
      label: "正在推进目标",
      current: message.value.iterations,
      detail: message.value.last_reason || message.value.condition,
    }];
  }
  if (parentToolUseId(message)) return [];
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
  if (message.type === "tool_progress") {
    if (
      typeof message.tool_use_id !== "string"
      || typeof message.elapsed_time_seconds !== "number"
      || !Number.isFinite(message.elapsed_time_seconds)
    ) return [];
    return [{
      type: "runtime_progress",
      progressId: `claude:tool:${message.tool_use_id}`,
      phase: "tool",
      label: typeof message.tool_name === "string" && message.tool_name
        ? `正在使用 ${message.tool_name}`
        : "正在使用工具",
      toolCallId: message.tool_use_id,
      elapsedSeconds: Math.max(0, message.elapsed_time_seconds),
      detail: `${Math.max(0, Math.round(message.elapsed_time_seconds))} 秒`,
    }];
  }
  if (message.type === "system" && message.subtype === "thinking_tokens") {
    if (typeof message.estimated_tokens !== "number" || !Number.isFinite(message.estimated_tokens)) return [];
    const estimatedTokens = Math.max(0, Math.round(message.estimated_tokens));
    return [{
      type: "runtime_progress",
      progressId: "claude:thinking",
      phase: "thinking",
      label: "正在思考",
      current: estimatedTokens,
      detail: `${estimatedTokens.toLocaleString("en-US")} tokens`,
    }];
  }
  if (message.type === "system" && message.subtype === "api_retry") {
    if (
      typeof message.attempt !== "number"
      || typeof message.max_retries !== "number"
      || !Number.isFinite(message.attempt)
      || !Number.isFinite(message.max_retries)
    ) return [];
    const attempt = Math.max(0, Math.round(message.attempt));
    const maxRetries = Math.max(0, Math.round(message.max_retries));
    return [{
      type: "runtime_progress",
      progressId: "claude:api-retry",
      phase: "retry",
      label: "请求重试",
      current: attempt,
      total: maxRetries,
      detail: `${attempt}/${maxRetries}`,
    }];
  }
  if (message.type === "system" && message.subtype === "status" && message.status) {
    const label = message.status === "compacting" ? "正在压缩上下文" : "正在请求模型";
    return [{
      type: "runtime_progress",
      progressId: "claude:status",
      phase: "status",
      label,
    }];
  }
  if (message.type === "system" && message.subtype === "informational") {
    if (typeof message.content !== "string" || !message.content.trim()) return [];
    return [{
      type: "runtime_progress",
      progressId: message.tool_use_id ? `claude:info:${message.tool_use_id}` : "claude:info",
      phase: "status",
      label: message.content.trim(),
      ...(message.tool_use_id ? { toolCallId: message.tool_use_id } : {}),
    }];
  }
  if (message.type === "system" && message.subtype === "hook_progress") {
    if (typeof message.hook_name !== "string" || !message.hook_name.trim()) return [];
    return [{
      type: "runtime_progress",
      progressId: `claude:hook:${message.hook_id}`,
      phase: "status",
      label: `正在运行 ${message.hook_name.trim()}`,
      detail: typeof message.hook_event === "string" && message.hook_event.trim()
        ? message.hook_event.trim()
        : undefined,
    }];
  }
  if (message.type === "system" && message.subtype === "task_progress") {
    if (typeof message.task_id !== "string" || typeof message.description !== "string" || !message.description.trim()) return [];
    const elapsedSeconds = typeof message.usage?.duration_ms === "number" && Number.isFinite(message.usage.duration_ms)
      ? Math.max(0, Math.round(message.usage.duration_ms / 1000))
      : undefined;
    return [{
      type: "runtime_progress",
      progressId: `claude:task:${message.task_id}`,
      phase: "status",
      label: message.description.trim(),
      ...(message.tool_use_id ? { toolCallId: message.tool_use_id } : {}),
      ...(elapsedSeconds === undefined ? {} : { elapsedSeconds, detail: `${elapsedSeconds} 秒` }),
    }];
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

function claudeResultToEvent(
  message: Extract<SDKMessage, { type: "result" }>,
  streamedText: string,
): Extract<AgentEvent, { type: "done" | "error" }> {
  if (message.subtype === "success" && !message.is_error) {
    return { type: "done", finalText: message.result || streamedText };
  }
  const text = "result" in message && typeof message.result === "string"
    ? message.result
    : "errors" in message && Array.isArray(message.errors)
      ? message.errors.join("\n")
      : "Claude Code run failed";
  return { type: "error", message: text || "Claude Code run failed" };
}

function parentToolUseId(message: SDKMessage): string | null {
  if (!("parent_tool_use_id" in message)) return null;
  return typeof message.parent_tool_use_id === "string" && message.parent_tool_use_id
    ? message.parent_tool_use_id
    : null;
}

function finiteSeconds(durationMs: number): number | undefined {
  return Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs / 1000)) : undefined;
}

function finiteCount(value: number): number | undefined {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : undefined;
}

function claudeTaskStatus(
  status: "pending" | "running" | "completed" | "failed" | "killed" | "paused",
): NativeSubagentActivity["status"] {
  if (status === "completed" || status === "failed") return status;
  if (status === "killed") return "stopped";
  return "running";
}

function appendClaudeText(messages: Message[], text: string): Message[] {
  if (!text) return messages;
  const last = messages[messages.length - 1];
  if (last?.role === "assistant" && !last.toolCalls?.length) {
    return [...messages.slice(0, -1), { ...last, content: last.content + text }];
  }
  return [...messages, { role: "assistant", content: text }];
}

function appendClaudeToolCall(messages: Message[], toolCall: ToolCall): Message[] {
  const last = messages[messages.length - 1];
  if (last?.role === "assistant") {
    return [
      ...messages.slice(0, -1),
      { ...last, toolCalls: [...(last.toolCalls ?? []), toolCall] },
    ];
  }
  return [...messages, { role: "assistant", content: "", toolCalls: [toolCall] }];
}

function appendClaudeToolResult(
  messages: Message[],
  toolCallId: string,
  content: string,
  isError: boolean,
): Message[] {
  return [...messages, {
    role: "tool",
    content,
    toolCallId,
    ...(isError ? { name: "error" } : {}),
  }];
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
