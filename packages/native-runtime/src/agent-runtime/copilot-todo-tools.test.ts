import { describe, expect, it, vi } from "vitest";
import { ActionType, type ActionEnvelope, type ActiveTurn, type ChatState, type SessionState, type StateAction, type ToolCallState } from "@microsoft/agent-host-protocol";
import { CopilotTodoTools } from "./copilot-todo-tools.js";
import type { CopilotAhpConnection } from "./copilot-ahp-connection.js";

const config = { command: "node", args: [], env: { AGENTROAM_TODO_DESCRIPTOR: "scoped.json", AGENTROAM_DISCOVERY_DIR: "registry" } };
function fixture() {
  const actions: Array<{ channel: string; action: StateAction }> = [];
  const callbacks = new Set<(event: ActionEnvelope) => void>();
  const session = { activeClients: [{ clientId: "editor", displayName: "VS Code", tools: [] }] } as unknown as SessionState;
  const chats = new Map<string, ChatState>();
  const host = {
    clientId: "agentroam-test", connected: true,
    session: vi.fn(async () => session), sessionState: () => session,
    chatState: (id: string) => chats.get(id)!,
    dispatch: vi.fn(async (channel: string, action: StateAction) => {
      actions.push({ channel, action });
      if (action.type === ActionType.SessionActiveClientSet) session.activeClients = [...session.activeClients.filter(c => c.clientId !== action.activeClient.clientId), action.activeClient];
      if (action.type === ActionType.SessionActiveClientRemoved) session.activeClients = session.activeClients.filter(c => c.clientId !== action.clientId);
    }),
    onAction: (callback: (event: ActionEnvelope) => void) => { callbacks.add(callback); return () => { callbacks.delete(callback); }; },
  };
  function publish(chat = "chat", turnId = "turn", contributor = host.clientId, toolName = "todo_list", input = "{}") {
    const call = { toolCallId: "call", toolName, displayName: toolName, status: "running", invocationMessage: "Todo", toolInput: input,
      contributor: { kind: "client", clientId: contributor } } as ToolCallState;
    chats.set(chat, { resource: chat, activeTurn: { id: turnId, responseParts: [{ kind: "toolCall", toolCall: call }] } as ActiveTurn } as ChatState);
    for (const callback of callbacks) callback({ channel: chat, action: { type: ActionType.ChatToolCallReady, turnId, toolCallId: "call", invocationMessage: "Todo" } } as ActionEnvelope);
  }
  return { host: host as unknown as CopilotAhpConnection, actions, chats, session, publish };
}
const tool = (name: string, execute = vi.fn(async () => ({ toolCallId: "", content: '{"items":[]}', isError: false }))) => ({ name, description: "Scoped Todo", parameters: { type: "object", properties: {} }, execute });

describe("Copilot session-scoped Todo client tools", () => {
  it("publishes only this client's tools, executes once, and removes only this contribution", async () => {
    const f = fixture(); const list = tool("todo_list");
    const provision = vi.fn(async () => [list] as never);
    const detach = await new CopilotTodoTools(provision).attach(f.host, "session", "chat", "turn", config);
    expect(provision).toHaveBeenCalledWith("scoped.json", "registry");
    expect(f.session.activeClients.map(c => c.clientId)).toEqual(["editor", "agentroam-test"]);
    f.publish(); f.publish();
    await vi.waitFor(() => expect(f.actions.some(e => e.action.type === ActionType.ChatToolCallComplete)).toBe(true));
    expect(list.execute).toHaveBeenCalledOnce();
    expect(f.actions.at(-1)).toMatchObject({ channel: "chat", action: { type: ActionType.ChatToolCallComplete, turnId: "turn", result: { success: true, content: [{ type: "text", text: '{"items":[]}' }] } } });
    await detach();
    expect(f.session.activeClients).toEqual([{ clientId: "editor", displayName: "VS Code", tools: [] }]);
  });

  it("does not execute another contributor, chat, or native turn", async () => {
    const f = fixture(); const list = tool("todo_list");
    const detach = await new CopilotTodoTools(async () => [list] as never).attach(f.host, "session", "chat", "turn", config);
    f.publish("chat", "turn", "editor"); f.publish("other-chat"); f.publish("chat", "old-turn");
    await Promise.resolve();
    expect(list.execute).not.toHaveBeenCalled();
    expect(f.actions.filter(e => e.action.type === ActionType.ChatToolCallComplete)).toEqual([]);
    await detach();
  });

  it("returns a failed native tool result for a capability outside the credential scope", async () => {
    const f = fixture(); const get = tool("todo_get");
    const detach = await new CopilotTodoTools(async () => [get] as never).attach(f.host, "session", "chat", "turn", config);
    f.publish("chat", "turn", f.host.clientId, "todo_create", '{"title":"blocked"}');
    await vi.waitFor(() => expect(f.actions.some(e => e.action.type === ActionType.ChatToolCallComplete)).toBe(true));
    expect(get.execute).not.toHaveBeenCalled();
    expect(f.actions.at(-1)?.action).toMatchObject({ type: ActionType.ChatToolCallComplete, result: { success: false } });
    await detach();
  });

  it("retains another admitted chat's tools until its own registration ends", async () => {
    const f = fixture();
    const bridge = new CopilotTodoTools(async () => [tool("todo_list")] as never);
    const [first, second] = await Promise.all([
      bridge.attach(f.host, "session", "first", "turn-1", config),
      bridge.attach(f.host, "session", "second", "turn-2", config),
    ]);
    await first();
    expect(f.session.activeClients.find(c => c.clientId === f.host.clientId)?.tools.map(t => t.name)).toEqual(["todo_list"]);
    await second();
    expect(f.session.activeClients.map(c => c.clientId)).toEqual(["editor"]);
  });

  it("restores an existing contribution from the same client", async () => {
    const f = fixture(); const existing = { clientId: f.host.clientId, displayName: "Existing", tools: [{ name: "editor_tool" }] };
    f.session.activeClients.push(existing);
    const detach = await new CopilotTodoTools(async () => [tool("todo_list")] as never).attach(f.host, "session", "chat", "turn", config);
    await detach();
    expect(f.session.activeClients.find(c => c.clientId === f.host.clientId)).toEqual(existing);
  });

  it("does not leave a contribution after the native host rejects registration", async () => {
    const f = fixture();
    vi.mocked(f.host.dispatch).mockRejectedValueOnce(new Error("rejected"));
    await expect(new CopilotTodoTools(async () => [tool("todo_list")] as never).attach(f.host, "session", "chat", "turn", config)).rejects.toThrow("rejected");
    expect(f.session.activeClients.map(c => c.clientId)).toEqual(["editor"]);
  });

  it("reports an uncertain native result delivery without retrying the Todo write", async () => {
    const f = fixture(); const create = tool("todo_create"); const failed = vi.fn();
    const detach = await new CopilotTodoTools(async () => [create] as never).attach(f.host, "session", "chat", "turn", config, failed);
    vi.mocked(f.host.dispatch).mockRejectedValueOnce(new Error("result echo timed out"));
    f.publish("chat", "turn", f.host.clientId, "todo_create", '{"title":"one write","requestId":"stable"}');
    await vi.waitFor(() => expect(failed).toHaveBeenCalledOnce());
    f.publish("chat", "turn", f.host.clientId, "todo_create", '{"title":"one write","requestId":"stable"}');
    expect(create.execute).toHaveBeenCalledOnce();
    await detach();
  });
});
