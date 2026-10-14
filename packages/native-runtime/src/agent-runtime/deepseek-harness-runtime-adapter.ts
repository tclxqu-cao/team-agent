import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { AgentEvent } from "@agent/core";
import { DeepSeekHarnessClient, harnessRecord, type HarnessConnection, type HarnessRecord } from "./deepseek-harness-client.js";
import { decodeHarnessHistory, harnessChunkEvent, harnessMessage, harnessToolCall } from "./deepseek-harness-codec.js";
import { decodeHarnessGoal } from "./deepseek-harness-goal-codec.js";
import { HarnessInteractions } from "./deepseek-harness-interactions.js";
import { harnessQuestionProjection } from "./deepseek-harness-interaction-codec.js";
import { AsyncEventQueue } from "./async-event-queue.js";
import { HarnessJobs } from "./deepseek-harness-jobs.js";
import { parseNativeGoalMutation, type NativeGoalMutation, type NativeSessionGoal } from "./native-session-goal.js";
import { parseImageDataUrls } from "./image-input.js";
import { encodeUnifiedSessionId } from "./session-id.js";
import { normalizeAgentWorkspacePath, paginateByOffset } from "./agent-workspace-index.js";
import type { NativeSessionPermissions } from "./types.js";
import { RuntimeSessionError, type AgentRuntimeAdapter, type AgentWorkspace, type CreateRuntimeSessionOptions, type RuntimeHealth, type RuntimeModelInfo, type RuntimeQuestionAnswer, type RuntimeRunOptions, type UnifiedSessionDetail, type UnifiedSessionSummary, type WorkspacePage, type WorkspaceQuery, type WorkspaceSessionQuery } from "./types.js";

type HarnessSessionAddress =
  | { kind: "session"; sessionId: string }
  | { kind: "subagent"; parentSessionId: string; childSessionId: string; mode: "one-shot" | "continuable" | "unknown" };

function harnessSessionAddress(row: HarnessRecord): HarnessSessionAddress {
  const sessionId = String(row.sessionId);
  if (row.origin !== "subagent") return { kind: "session", sessionId };
  if (typeof row.parentSessionId !== "string" || !row.parentSessionId.trim()) {
    throw new RuntimeSessionError("DeepSeek Harness 子会话缺少父会话地址", "NATIVE_PROTOCOL_ERROR");
  }
  const projections = row.projections ? harnessRecord(harnessRecord(row.projections).values) : {};
  const mode = projections.subagent ? harnessRecord(projections.subagent).mode : undefined;
  return { kind: "subagent", parentSessionId: row.parentSessionId, childSessionId: sessionId,
    mode: mode === "one-shot" || mode === "continuable" ? mode : "unknown" };
}

export class DeepSeekHarnessRuntimeAdapter implements AgentRuntimeAdapter {
  readonly agentType = "deepseek-harness" as const;
  private readonly running = new Set<string>();
  private readonly workspaces = new Map<string, AgentWorkspace>();
  private readonly interactions: HarnessInteractions;
  constructor(private readonly client: HarnessConnection = new DeepSeekHarnessClient()) { this.interactions = new HarnessInteractions(client); }

  async health(): Promise<RuntimeHealth> {
    try { await this.client.request("session/list", { _request: {} }); return { agentType: this.agentType, label: "DeepSeek Harness", available: true }; }
    catch (error) { return { agentType: this.agentType, label: "DeepSeek Harness", available: false, error: error instanceof Error ? error.message : "运行时不可用" }; }
  }

  private summary(row: HarnessRecord, permissionOptions: NativeSessionPermissions["options"] = [], modes: NonNullable<UnifiedSessionSummary["nativeMode"]>["options"] = []): UnifiedSessionSummary {
    const id = String(row.sessionId);
    const projections = row.projections ? harnessRecord(harnessRecord(row.projections).values) : {};
    const updated = new Date(typeof row.updatedAt === "number" ? row.updatedAt : Date.now()).toISOString();
    const active = this.running.has(id);
    // A cold session also has agentAvailable=false; only confirmed activity
    // or a native writer-held response establishes another owner's lock.
    const external = !active && row.running === true;
    const selection = projections.permissions ? harnessRecord(projections.permissions) : {};
    const isSubagent = row.origin === "subagent";
    const oneShot = row.origin === "subagent" && projections.subagent
      && harnessRecord(projections.subagent).mode === "one-shot";
    return { id: encodeUnifiedSessionId(this.agentType, id), agentType: this.agentType, nativeSessionId: id,
      title: typeof projections.title === "string" && projections.title ? projections.title : "DeepSeek Harness 会话", cwd: typeof row.cwd === "string" ? row.cwd : "",
      created: updated, updated, status: active || row.running === true ? "running" : "idle",
      occupancy: active ? "owned-by-customer-agent" : external ? "owned-externally" : "available",
      sourceLabel: "DeepSeek Harness", canResume: !external && !oneShot, canDelete: false,
      nativeMode: { currentValue: typeof projections.agentPreset === "string" ? projections.agentPreset : "standard", canChange: row.blank === true && !isSubagent && !active && !external, options: modes },
      nativeGoalSupported: !isSubagent, nativeModelSelectionSupported: !isSubagent,
      ...(typeof selection.currentValue === "string" ? {
        nativePermissions: { currentValue: selection.currentValue, options: isSubagent ? [] : permissionOptions },
      } : {}),
      ...(typeof row.parentSessionId === "string" ? { parentSessionId: encodeUnifiedSessionId(this.agentType, row.parentSessionId) } : {}),
    };
  }

  async discoverSessions(): Promise<UnifiedSessionSummary[]> {
    const [raw, catalog, modeCatalog] = await Promise.all([
      this.client.request("session/list", { _request: {} }),
      this.client.request("permissionPresets/catalog", {}).catch(() => null),
      this.client.request("agentPresets/list", {}).catch(() => null),
    ]);
    const result = harnessRecord(raw);
    if (!Array.isArray(result.items)) throw new RuntimeSessionError("DeepSeek Harness 会话列表格式无效", "NATIVE_PROTOCOL_ERROR");
    const options: NativeSessionPermissions["options"] = [];
    if (catalog) {
      const rows = harnessRecord(catalog).options;
      if (Array.isArray(rows)) for (const rawOption of rows) {
        const option = harnessRecord(rawOption);
        if (typeof option.value !== "string" || !option.value.trim()) continue;
        options.push({ value: option.value, label: typeof option.name === "string" ? option.name : option.value,
          ...(typeof option.description === "string" ? { description: option.description } : {}) });
      }
    }
    const names: Record<string, string> = { standard: "标准模式", ptc: "PTC 模式", minimal: "极简模式", cordis: "创作模式" };
    const presets = modeCatalog ? harnessRecord(modeCatalog).presets : [];
    const modes = Array.isArray(presets) ? presets.map(harnessRecord).filter(row => typeof row.id === "string").map(row => ({
      value: String(row.id), label: typeof row.name === "string" ? row.name : names[String(row.id)] ?? String(row.id),
      ...(typeof row.description === "string" ? { description: row.description } : {}),
    })) : [];
    return result.items.map(item => this.summary(harnessRecord(item), options, modes));
  }

  async listWorkspaces(query: WorkspaceQuery = {}): Promise<WorkspacePage<AgentWorkspace>> {
    const sessions = (await this.discoverSessions()).sort((a, b) => b.updated.localeCompare(a.updated));
    const workspaces = new Map<string, AgentWorkspace>();
    for (const session of sessions) {
      if (!session.cwd.trim()) continue;
      const cwd = normalizeAgentWorkspacePath(session.cwd);
      const workspaceId = `harness:${createHash("sha256").update(cwd).digest("base64url").slice(0, 24)}`;
      if (workspaces.has(workspaceId)) continue;
      const workspace: AgentWorkspace = { agentType: this.agentType, workspaceId, name: basename(cwd) || cwd, roots: [cwd], order: workspaces.size, updatedAt: session.updated, source: "derived", canCreateSession: true };
      workspaces.set(workspaceId, workspace);
      this.workspaces.set(workspaceId, workspace);
    }
    return paginateByOffset([...workspaces.values()], query, sessions[0]?.updated ?? null);
  }

  async listWorkspaceSessions(workspaceId: string, query: WorkspaceSessionQuery = {}): Promise<WorkspacePage<UnifiedSessionSummary>> {
    if (!this.workspaces.has(workspaceId)) await this.listWorkspaces({ limit: 200 });
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) throw new RuntimeSessionError("DeepSeek Harness 目录不存在", "SESSION_NOT_FOUND");
    const page = await this.listWorkspaceSessionsByPath(workspace.roots[0], query);
    return { ...page, data: page.data.map(session => ({ ...session, projectId: workspaceId })) };
  }

  async listWorkspaceSessionsByPath(cwd: string, query: WorkspaceSessionQuery = {}): Promise<WorkspacePage<UnifiedSessionSummary>> {
    const path = normalizeAgentWorkspacePath(cwd);
    const sessions = (await this.discoverSessions()).filter(session => session.cwd.trim() && normalizeAgentWorkspacePath(session.cwd) === path).sort((a, b) => b.updated.localeCompare(a.updated));
    return paginateByOffset(sessions, query, sessions[0]?.updated ?? null);
  }

  async getSession(nativeSessionId: string): Promise<UnifiedSessionDetail> {
    await this.interactions.start();
    const summary = (await this.discoverSessions()).find(row => row.nativeSessionId === nativeSessionId);
    if (!summary) throw new RuntimeSessionError("DeepSeek Harness 会话不存在", "SESSION_NOT_FOUND");
    const address = harnessSessionAddress(await this.readSessionRow(nativeSessionId));
    const stream = await this.client.follow({ address, maxMessages: 100 });
    let snapshot: HarnessRecord | null = null;
    try { for await (const frame of stream.values) { if (frame.type === "snapshot") { snapshot = frame; break; } } } finally { stream.close(); }
    if (!snapshot || !Array.isArray(snapshot.records)) throw new RuntimeSessionError("DeepSeek Harness 历史快照缺失", "NATIVE_PROTOCOL_ERROR");
    let records = snapshot.records.map(harnessRecord);
    let hasMore = snapshot.hasMore === true;
    while (hasMore) {
      const beforeSeq = records.length ? Number(harnessRecord(records[0].event).seq) : 0;
      const page = harnessRecord(await this.client.request("session/page", { request: { address, throughSeq: snapshot.cursor, beforeSeq, maxMessages: 100 } }));
      if (!Array.isArray(page.records) || page.records.length === 0) throw new RuntimeSessionError("DeepSeek Harness 历史分页没有推进", "NATIVE_PROTOCOL_ERROR");
      const previous = page.records.map(harnessRecord);
      if (Number(harnessRecord(previous[previous.length - 1].event).seq) >= beforeSeq) throw new RuntimeSessionError("DeepSeek Harness 历史游标无效", "NATIVE_PROTOCOL_ERROR");
      records = [...previous, ...records]; hasMore = page.hasMore === true;
    }
    const header = harnessRecord(snapshot.header);
    const history = decodeHarnessHistory(records);
    const questions = this.interactions.events(nativeSessionId, await this.readQuestionProjections(nativeSessionId));
    const warnings: AgentEvent[] = [];
    const jobs = await new HarnessJobs(this.client, nativeSessionId, event => warnings.push(event)).snapshot();
    return { ...summary, created: new Date(Number(header.createdAt)).toISOString(), ...history, events: [...history.events, ...questions, ...jobs, ...warnings] };
  }

  private async readSessionRow(nativeSessionId: string): Promise<HarnessRecord> {
    const result = harnessRecord(await this.client.request("session/list", { _request: {} }));
    const row = Array.isArray(result.items) ? result.items.map(harnessRecord).find(item => item.sessionId === nativeSessionId) : undefined;
    if (!row) throw new RuntimeSessionError("DeepSeek Harness 会话不存在", "SESSION_NOT_FOUND");
    return row;
  }

  private async readQuestionProjections(nativeSessionId: string): Promise<HarnessRecord> {
    return harnessQuestionProjection(await this.readSessionRow(nativeSessionId));
  }

  async create(options: CreateRuntimeSessionOptions): Promise<UnifiedSessionSummary> {
    const result = harnessRecord(await this.client.request("session/create", { request: { cwd: options.cwd } }));
    const id = String(result.sessionId);
    if (options.title.trim()) await this.renameSession(id, options.title);
    const summary = (await this.discoverSessions()).find(row => row.nativeSessionId === id);
    if (!summary) throw new RuntimeSessionError("DeepSeek Harness 未确认新会话", "NATIVE_PROTOCOL_ERROR");
    return { ...summary, projectId: options.projectId };
  }

  async renameSession(nativeSessionId: string, title: string): Promise<void> { await this.client.request("session/rename", { request: { sessionId: nativeSessionId, title } }); }

  async setNativeMode(nativeSessionId: string, preset: string): Promise<UnifiedSessionSummary> {
    const current = (await this.discoverSessions()).find(row => row.nativeSessionId === nativeSessionId);
    if (!current) throw new RuntimeSessionError("DeepSeek Harness 会话不存在", "SESSION_NOT_FOUND");
    if (!current.nativeMode?.canChange) throw new RuntimeSessionError("已有消息的会话不能切换模式，请在新会话中选择", "OPERATION_NOT_SUPPORTED");
    if (!current.nativeMode.options.some(option => option.value === preset)) throw new RuntimeSessionError("不支持此模式", "OPERATION_NOT_SUPPORTED");
    await this.withLiveSession(nativeSessionId, () => this.client.request("agentPresets/select", { agentId: nativeSessionId, agentPreset: preset }));
    const updated = (await this.discoverSessions()).find(row => row.nativeSessionId === nativeSessionId);
    if (updated?.nativeMode?.currentValue !== preset) throw new RuntimeSessionError("Harness 未确认模式切换", "NATIVE_PROTOCOL_ERROR");
    return updated;
  }

  async setNativePermissionPreset(nativeSessionId: string, preset: string): Promise<UnifiedSessionSummary> {
    const current = (await this.discoverSessions()).find(row => row.nativeSessionId === nativeSessionId);
    if (!current) throw new RuntimeSessionError("DeepSeek Harness 会话不存在", "SESSION_NOT_FOUND");
    if (!/^[a-zA-Z0-9_.-]+$/.test(preset) || !current.nativePermissions?.options.some(option => option.value === preset)) {
      throw new RuntimeSessionError("DeepSeek Harness 不支持此权限选项", "OPERATION_NOT_SUPPORTED");
    }
    // Following a cold session lets the native Host activate its writer.
    // Execute Harness's command writer; never replace its policy locally.
    const execution = await this.withLiveSession(nativeSessionId, () => this.client.request("commands/execute", {
      agentId: nativeSessionId, line: `/permission ${preset}`, submittedAttachments: [],
    }));
    if (!execution) throw new RuntimeSessionError("DeepSeek Harness 未提供权限命令", "OPERATION_NOT_SUPPORTED");
    const result = harnessRecord(harnessRecord(execution).result);
    if (result.kind !== "success") {
      throw new RuntimeSessionError(typeof result.text === "string" ? result.text : "DeepSeek Harness 权限更新失败", "NATIVE_PROTOCOL_ERROR");
    }
    const updated = (await this.discoverSessions()).find(row => row.nativeSessionId === nativeSessionId);
    if (!updated || updated.nativePermissions?.currentValue !== preset) {
      throw new RuntimeSessionError("DeepSeek Harness 未确认权限更新，请刷新后重试", "NATIVE_PROTOCOL_ERROR");
    }
    return updated;
  }

  private async withLiveSession<T>(nativeSessionId: string, action: () => Promise<T>): Promise<T> {
    // Advance past the opening snapshot: follow promotes a cold session's writer
    // after yielding it. Keep the follower open through the RPC, without takeover.
    const address = harnessSessionAddress(await this.readSessionRow(nativeSessionId));
    const stream = await this.client.follow({ address, maxMessages: 1 });
    const iterator = stream.values[Symbol.asyncIterator]();
    try {
      const opening = await iterator.next();
      if (opening.done || opening.value.type !== "snapshot") throw new RuntimeSessionError("DeepSeek Harness 会话快照缺失", "NATIVE_PROTOCOL_ERROR");
      void iterator.next().catch(() => undefined);
      return await action();
    } finally { stream.close(); }
  }

  async getNativeGoal(nativeSessionId: string): Promise<NativeSessionGoal | null> {
    // goals/get resolves an ordinary Agent, so child history access does not
    // authorize it. Unsupported child controls must not activate a writer.
    if ((await this.readSessionRow(nativeSessionId)).origin === "subagent") return null;
    return this.withLiveSession(nativeSessionId, async () => decodeHarnessGoal(
      await this.client.request("goals/get", { agentId: nativeSessionId }),
    ));
  }

  async mutateNativeGoal(nativeSessionId: string, input: NativeGoalMutation): Promise<NativeSessionGoal | null> {
    const mutation = parseNativeGoalMutation(input);
    if ((await this.readSessionRow(nativeSessionId)).origin === "subagent") {
      throw new RuntimeSessionError("DeepSeek Harness 子会话不支持单独设置目标", "OPERATION_NOT_SUPPORTED");
    }
    return this.withLiveSession(nativeSessionId, async () => {
      if (mutation.action === "create") {
        const { action: _action, ...request } = mutation;
        const result = harnessRecord(await this.client.request("goals/create", { agentId: nativeSessionId, request }));
        const ref = harnessRecord(result.ref);
        if (typeof ref.id !== "string" || !Number.isSafeInteger(ref.revision)) throw new RuntimeSessionError("DeepSeek Harness 未确认目标创建", "NATIVE_PROTOCOL_ERROR");
      } else {
        const { action, ref, ...request } = mutation;
        const current = decodeHarnessGoal(await this.client.request("goals/get", { agentId: nativeSessionId }));
        if (!current || current.id !== ref.id || current.revision !== ref.revision) {
          throw new RuntimeSessionError("目标已在其他客户端修改，请刷新后重试", "NATIVE_GOAL_CONFLICT");
        }
        await this.client.request(`goals/${action}`, {
          agentId: nativeSessionId, ref, ...(action === "edit" ? { request } : {}),
        });
      }
      // Read the authoritative view; never invent local goal phases or activation.
      return decodeHarnessGoal(await this.client.request("goals/get", { agentId: nativeSessionId }));
    });
  }

  async *run(nativeSessionId: string, input: string, images?: string[], _agentIds?: string[], _agentName?: string, options?: RuntimeRunOptions): AsyncIterable<AgentEvent> {
    if (this.running.has(nativeSessionId)) throw new RuntimeSessionError("DeepSeek Harness 会话正在执行", "SESSION_ALREADY_RUNNING");
    const address = harnessSessionAddress(await this.readSessionRow(nativeSessionId));
    if (address.kind === "subagent" && address.mode === "one-shot") {
      throw new RuntimeSessionError("DeepSeek Harness 一次性子会话仅支持查看", "OPERATION_NOT_SUPPORTED");
    }
    if (address.kind === "subagent" && (options?.model || options?.reasoningEffort)) {
      throw new RuntimeSessionError("DeepSeek Harness 子会话沿用原生模型设置，不支持单独切换模型", "OPERATION_NOT_SUPPORTED");
    }
    // Address discovery awaits the Host; another send may have claimed this session.
    if (this.running.has(nativeSessionId)) throw new RuntimeSessionError("DeepSeek Harness 会话正在执行", "SESSION_ALREADY_RUNNING");
    this.running.add(nativeSessionId);
    const stream = await this.client.follow({ address, maxMessages: 1, assistantStream: true }).catch(error => { this.running.delete(nativeSessionId); throw error; });
    let streamClosed = false;
    const closeStream = () => { if (!streamClosed) { streamClosed = true; stream.close(); } };
    try {
      await this.interactions.start();
      const iterator = stream.values[Symbol.asyncIterator]();
      const opening = await iterator.next();
      if (opening.done || opening.value.type !== "snapshot") throw new RuntimeSessionError("DeepSeek Harness 没有返回执行快照", "NATIVE_PROTOCOL_ERROR");
      const queue = new AsyncEventQueue<{ frame?: HarnessRecord; interaction?: AgentEvent; error?: unknown }>();
      const unsubscribe = this.interactions.subscribe(nativeSessionId, interaction => queue.push({ interaction }));
      const jobs = new HarnessJobs(this.client, nativeSessionId, interaction => queue.push({ interaction }));
      const watchingJobs = jobs.watch();
      let stopFrames = false;
      const frames = (async () => {
        try {
          while (!stopFrames) {
            const next = await iterator.next();
            if (next.done) { if (!stopFrames) queue.push({ error: new RuntimeSessionError("DeepSeek Harness 执行连接提前结束", "RUNTIME_UNAVAILABLE") }); break; }
            queue.push({ frame: next.value });
          }
        } catch (error) { if (!stopFrames) queue.push({ error }); }
      })();
      try {
        if (options?.model) await this.client.request("session/selectModel", { request: { sessionId: nativeSessionId, provider: options.model.providerID || "deepseek-official", model: options.model.id, ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}) } });
        // Native permission decisions remain owned by Harness. Do not silently replace its policy.
        const content = [{ type: "text", text: input }, ...parseImageDataUrls(images).map(image => ({ type: "image", mediaType: image.mimeType, data: image.base64 }))];
        if (address.kind === "subagent") {
          await this.client.request("subagents/prompt", { request: { requestId: randomUUID(),
            parentSessionId: address.parentSessionId, childSessionId: address.childSessionId,
            mode: "continuable", delivery: "queue", content } });
        } else {
          await this.client.request("session/prompt", { request: { requestId: randomUUID(), sessionId: nativeSessionId, mode: "queue", content } });
        }
        yield { type: "thinking", message: "DeepSeek Harness 正在处理" };
        // Durable assistant/message precedes the stream end marker in Harness.
        // Match by turn/step so its committed text does not repeat live deltas.
        const attempts = new Map<string, { key: string; text: string; reasoning: string }>();
        const streamed = new Map<string, { text: string; reasoning: string }>();
        let finalText = "";
        for await (const item of queue) {
          if (item.error) throw item.error;
          if (item.interaction) { yield item.interaction; continue; }
          if (!item.frame) continue;
          const frame = item.frame;
          if (frame.type === "assistant-stream") {
            const live = harnessRecord(frame.frame);
            const attemptId = String(live.attemptId);
            if (live.type === "start") attempts.set(attemptId, { key: `${live.turn}:${live.step}`, text: "", reasoning: "" });
            const event = harnessChunkEvent(live);
            const attempt = attempts.get(attemptId);
            if (event) {
              if (attempt) {
                if (event.type === "text_chunk") attempt.text += event.text;
                if (event.type === "reasoning_summary_delta") attempt.reasoning += event.delta;
                streamed.set(attempt.key, attempt);
              }
              yield event;
            }
            if (live.type === "end") {
              const outcome = harnessRecord(live.outcome);
              if (outcome.kind === "committed" && attempt) streamed.set(String(outcome.seq), attempt);
              attempts.delete(attemptId);
            }
          } else if (frame.type === "event") {
            const event = harnessRecord(frame.event), data = harnessRecord(event.data);
            if (event.type === "assistant/message") {
              const message = harnessMessage(event);
              finalText = message?.content ?? "";
              const live = streamed.get(String(event.seq)) ?? streamed.get(`${data.turn}:${data.step}`);
              for (const section of message?.presentation?.reasoning ?? []) {
                const delta = live?.reasoning && section.text.startsWith(live.reasoning) ? section.text.slice(live.reasoning.length) : section.text;
                if (delta) yield { type: "reasoning_summary_delta", itemId: section.itemId, sectionIndex: section.sectionIndex, delta };
              }
              const text = live?.text && finalText.startsWith(live.text) ? finalText.slice(live.text.length) : finalText;
              if (text) yield { type: "text_chunk", text };
              streamed.delete(`${data.turn}:${data.step}`);
              streamed.delete(String(event.seq));
              yield { type: "text_done" };
            } else if (event.type === "tool/call") yield { type: "tool_call", toolCall: harnessToolCall(data) };
            else if (event.type === "tool/result") { const message = harnessMessage(event); if (message) yield { type: "tool_result", result: { toolCallId: message.toolCallId || "", content: message.content, isError: message.isError } }; }
            else if (event.type === "turn/end") {
              const reason = typeof data.reason === "string" ? { kind: data.reason } : harnessRecord(data.reason);
              if (["aborted", "interrupted", "disposed"].includes(String(reason.kind))) yield { type: "turn_aborted" };
              else if (reason.kind !== "completed") {
                const error = reason.error ? harnessRecord(reason.error) : {};
                yield { type: "error", message: typeof error.message === "string" ? error.message : `DeepSeek Harness 执行结束：${String(reason.kind)}` };
              }
              yield { type: "done", finalText }; return;
            }
          }
        }
      } finally { stopFrames = true; unsubscribe(); await jobs.close(); await watchingJobs; queue.close(); closeStream(); await frames; }
    } finally { this.running.delete(nativeSessionId); closeStream(); }
  }

  async steer(nativeSessionId: string, input: string): Promise<boolean> {
    if (!this.running.has(nativeSessionId) || !input.trim()) return false;
    const address = harnessSessionAddress(await this.readSessionRow(nativeSessionId));
    if (address.kind === "subagent" && address.mode === "one-shot") {
      throw new RuntimeSessionError("DeepSeek Harness 一次性子会话不支持插话", "OPERATION_NOT_SUPPORTED");
    }
    if (!this.running.has(nativeSessionId)) return false;
    const content = [{ type: "text", text: input }];
    const result = harnessRecord(address.kind === "subagent"
      ? await this.client.request("subagents/prompt", { request: {
          requestId: randomUUID(), parentSessionId: address.parentSessionId,
          childSessionId: address.childSessionId, mode: "continuable", delivery: "steer", content,
        } })
      : await this.client.request("session/prompt", { request: {
          requestId: randomUUID(), sessionId: nativeSessionId, mode: "steer", content,
        } }));
    // Child prompts acknowledge the admitted message identity; ordinary prompts
    // acknowledge acceptance. Neither may consume the queue on an invalid reply.
    if (address.kind === "subagent"
      ? typeof result.messageId !== "string" || !result.messageId.trim()
      : result.accepted !== true) {
      throw new RuntimeSessionError("DeepSeek Harness 未确认插话接收", "NATIVE_PROTOCOL_ERROR");
    }
    return true;
  }

  async abort(nativeSessionId: string): Promise<void> {
    const address = harnessSessionAddress(await this.readSessionRow(nativeSessionId));
    if (address.kind === "subagent") {
      await this.client.request("subagents/interruptByParent", { childSessionId: address.childSessionId,
        parentSessionId: address.parentSessionId, mode: "continuable" });
    } else {
      await this.client.request("session/cancel", { request: { sessionId: nativeSessionId } });
    }
  }
  async answerQuestion(questionId: string, answer: RuntimeQuestionAnswer): Promise<boolean> {
    return this.interactions.answer(questionId, answer, id => this.withLiveSession(id, () => this.readQuestionProjections(id)));
  }

  async listModels(): Promise<RuntimeModelInfo[]> {
    const catalog = harnessRecord(await this.client.request("session/modelCatalog", {}));
    if (!Array.isArray(catalog.groups)) return [];
    return catalog.groups.flatMap(raw => { const group = harnessRecord(raw); return Array.isArray(group.models) ? group.models.map(rawModel => { const model = harnessRecord(rawModel); const reasoning = model.reasoning ? harnessRecord(model.reasoning) : {}; return { id: String(model.id), displayName: String(model.name), providerID: String(group.id), providerDisplayName: String(group.name), description: typeof model.description === "string" ? model.description : undefined, reasoningEfforts: Array.isArray(reasoning.efforts) ? reasoning.efforts.map(rawEffort => String(harnessRecord(rawEffort).id)).filter((id): id is "low" | "high" | "max" => ["low", "high", "max"].includes(id)) : undefined }; }) : []; });
  }

  dispose(): Promise<void> { this.interactions.dispose(); return this.client.dispose(); }
}
