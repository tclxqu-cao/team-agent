import { ActionType, ToolResultContentType, type ActiveTurn, type SessionActiveClient, type ToolDefinition } from "@microsoft/agent-host-protocol";
import { provisionedTodoTools } from "../todo-mcp/provisioned-todo-tools.js";
import { TODO_TOOLS } from "../todo-mcp/tool-definitions.js";
import type { CopilotAhpConnection } from "./copilot-ahp-connection.js";
import type { NativeTodoMcpConfiguration } from "./runtime-tool-injection.js";
import { RuntimeSessionError } from "./types.js";

type TodoTools = Awaited<ReturnType<typeof provisionedTodoTools>>;
interface Registration { tools: TodoTools }
interface SessionRegistration {
  previous?: SessionActiveClient;
  runs: Map<string, Registration>;
  publishing: Promise<void>;
}

/** AHP client tools stay on their native session and execute only for the
 * explicitly admitted chat/turn. Other clients' contributions are preserved. */
export class CopilotTodoTools {
  private readonly sessions = new WeakMap<CopilotAhpConnection, Map<string, SessionRegistration>>();

  constructor(private readonly provision = provisionedTodoTools) {}

  async attach(host: CopilotAhpConnection, session: string, chat: string, turnId: string, config: NativeTodoMcpConfiguration, onFailure?: (error: Error) => void): Promise<() => Promise<void>> {
    const descriptor = config.env.AGENTROAM_TODO_DESCRIPTOR;
    if (!descriptor) throw new RuntimeSessionError("Copilot Todo 工具缺少会话凭据", "OPERATION_NOT_SUPPORTED");
    const tools = await this.provision(descriptor, config.env.AGENTROAM_DISCOVERY_DIR);
    const bySession = this.sessions.get(host) ?? new Map<string, SessionRegistration>();
    this.sessions.set(host, bySession);
    let entry = bySession.get(session);
    if (!entry) {
      const state = await host.session(session);
      entry = bySession.get(session);
      if (!entry) {
        entry = { previous: state.activeClients.find(client => client.clientId === host.clientId), runs: new Map(), publishing: Promise.resolve() };
        bySession.set(session, entry);
      }
    }
    const key = JSON.stringify([chat, turnId]);
    if (entry.runs.has(key)) throw new RuntimeSessionError("Copilot Todo 工具已绑定此轮次", "SESSION_ALREADY_RUNNING");
    const registration = { tools };
    entry.runs.set(key, registration);
    const current = entry;
    let closed = false;
    const seen = new Set<string>();
    const pending = new Set<Promise<void>>();
    const publish = () => {
      const update = current.publishing.catch(() => undefined).then(async () => {
        const definitions = new Map<string, ToolDefinition>((current.previous?.tools ?? []).map(tool => [tool.name, tool]));
        for (const run of current.runs.values()) for (const tool of run.tools) definitions.set(tool.name, {
          name: tool.name, description: tool.description, inputSchema: tool.parameters as ToolDefinition["inputSchema"],
        });
        if (!current.runs.size && !current.previous) await host.dispatch(session, { type: ActionType.SessionActiveClientRemoved, clientId: host.clientId });
        else await host.dispatch(session, { type: ActionType.SessionActiveClientSet,
          activeClient: { ...current.previous, clientId: host.clientId, displayName: current.previous?.displayName ?? "AgentRoam", tools: [...definitions.values()] } });
      });
      current.publishing = update;
      return update;
    };
    const execute = async (turn: ActiveTurn) => {
      for (const part of turn.responseParts) {
        if (closed || part.kind !== "toolCall") continue;
        const call = part.toolCall;
        if (call.status !== "running" || call.contributor?.kind !== "client" || call.contributor.clientId !== host.clientId
          || !TODO_TOOLS.some(tool => tool.name === call.toolName) || seen.has(call.toolCallId)) continue;
        seen.add(call.toolCallId);
        const allowed = tools.find(tool => tool.name === call.toolName);
        let content: string;
        let success = false;
        try {
          if (!allowed) throw new Error("Tool not permitted by this Todo credential");
          if (typeof call.toolInput !== "string") throw new Error("Todo tools require inline JSON input");
          const input = JSON.parse(call.toolInput);
          if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Todo tool input must be an object");
          const result = await allowed.execute(input);
          content = result.content;
          success = result.isError !== true;
        } catch (error) { content = error instanceof Error ? error.message : "Todo operation failed"; }
        if (!closed && host.chatState(chat).activeTurn?.id === turnId) await host.dispatch(chat, {
          type: ActionType.ChatToolCallComplete, turnId, toolCallId: call.toolCallId,
          result: { success, pastTenseMessage: success ? "AgentRoam 待办操作完成" : "AgentRoam 待办操作失败", content: [{ type: ToolResultContentType.Text, text: content }] },
        });
      }
    };
    const stop = host.onAction(envelope => {
      if (closed || envelope.channel !== chat) return;
      const turn = host.chatState(chat).activeTurn;
      if (turn?.id !== turnId) return;
      const work = execute(turn);
      pending.add(work);
      void work.catch(error => onFailure?.(error instanceof Error ? error : new Error("Copilot Todo result delivery failed"))).finally(() => pending.delete(work));
    });
    try { await publish(); }
    catch (error) {
      closed = true; stop(); current.runs.delete(key);
      await publish().catch(() => undefined);
      if (!current.runs.size) bySession.delete(session);
      throw error;
    }
    return async () => {
      if (closed) return;
      closed = true; stop(); current.runs.delete(key);
      await Promise.allSettled(pending);
      try { if (host.connected) await publish(); }
      finally { if (!current.runs.size) bySession.delete(session); }
    };
  }
}
