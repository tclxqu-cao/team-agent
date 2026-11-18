import type { ChatMessage, TodoItem } from "../stores/agentStore";

export function normalizeSessionPlan(value: unknown): TodoItem[] | null {
  if (!Array.isArray(value)) return null;
  const items = value.flatMap((entry, index): TodoItem[] => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    const title = item.step ?? item.content ?? item.title ?? item.subject;
    if (typeof title !== "string" || !title.trim()) return [];
    return [{
      id: typeof item.id === "string" || typeof item.id === "number" ? String(item.id) : `plan-${index}`,
      title,
      status: item.status === "completed" ? "completed"
        : ["in_progress", "in-progress", "inProgress"].includes(String(item.status)) ? "in-progress" : "pending",
      ...(typeof item.agentName === "string" ? { agentName: item.agentName } : {}),
      ...(Array.isArray(item.dependsOn) ? { dependsOn: item.dependsOn.filter((entry): entry is string => typeof entry === "string") } : {}),
    }];
  });
  return value.length && !items.length ? null : items;
}

function resultObject(result: string | undefined): unknown {
  if (!result) return null;
  try { return JSON.parse(result); } catch { return null; }
}

function flattenSessionMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.flatMap(message => [message, ...flattenSessionMessages(message.executionTrace?.liveMessages ?? [])]);
}

function planToolName(name: string): string {
  return name.split(/[.:/]/).pop()!.replace(/[^a-z]/gi, "").toLowerCase();
}

/** All runtimes share tool calls: replay snapshots and incremental task updates. */
export function sessionPlanSnapshot(messages: readonly ChatMessage[]): TodoItem[] | null {
  const flattened = flattenSessionMessages(messages);
  const results = new Map(flattened.filter(message => message.role === "tool" && message.toolCallId)
    .map(message => [message.toolCallId!, message]));
  let plan: TodoItem[] | null = null;
  const seen = new Set<string>();
  for (const message of flattened) for (const tool of message.toolCalls ?? []) {
    if (seen.has(tool.id)) continue;
    seen.add(tool.id);
    const result = results.get(tool.id);
    if (tool.isError || result?.name === "error") continue;
    const name = planToolName(tool.name);
    const args = tool.arguments;
    const output = tool.result ?? result?.content;
    if (/(updateplan|todowrite|writetodos|managetodolist|updatetodolist|setplan)$/.test(name)) {
      const snapshot = normalizeSessionPlan(args.plan ?? args.todos ?? args.todoList ?? args.entries);
      if (snapshot) plan = snapshot;
    } else if (/(tasklist|todolist)$/.test(name)) {
      const data = resultObject(output);
      const snapshot = normalizeSessionPlan(Array.isArray(data) ? data : (data as { tasks?: unknown; todos?: unknown } | null)?.tasks ?? (data as { todos?: unknown } | null)?.todos);
      if (snapshot) plan = snapshot;
    } else if (name.endsWith("todoadd")) {
      const items = normalizeSessionPlan(args.todos);
      if (items) plan = [...(plan ?? []), ...items.map((item, index) => ({ ...item, id: `${tool.id}:${index}` }))];
    } else if (name.endsWith("taskcreate")) {
      const data = resultObject(output) as { id?: unknown; task?: { id?: unknown } } | null;
      const id = data?.task?.id ?? data?.id ?? /Task\s+#(\d+)\s+created/i.exec(output ?? "")?.[1] ?? tool.id;
      const items = normalizeSessionPlan([{ ...args, id }]);
      if (items) plan = [...(plan ?? []), ...items];
    } else if (/(taskupdate|todoupdate)$/.test(name) && plan) {
      const id = args.taskId ?? args.id;
      plan = plan.flatMap(item => {
        const matches = id !== undefined ? item.id === String(id)
          : typeof args.title === "string" && item.title.toLowerCase().includes(args.title.toLowerCase());
        if (!matches) return [item];
        if (args.status === "deleted") return [];
        return normalizeSessionPlan([{ ...item, ...args, id: item.id, title: args.subject ?? item.title }]) ?? [item];
      });
    }
  }
  return plan;
}

export function latestSessionPlan(messages: readonly ChatMessage[]): TodoItem[] {
  return sessionPlanSnapshot(messages) ?? [];
}

export function hasSessionPlanAdditions(previous: readonly TodoItem[], next: readonly TodoItem[]): boolean {
  const remaining = new Map<string, number>();
  for (const item of previous) {
    const title = item.title.trim();
    if (title) remaining.set(title, (remaining.get(title) ?? 0) + 1);
  }
  for (const item of next) {
    const title = item.title.trim();
    if (!title) continue;
    const count = remaining.get(title) ?? 0;
    if (!count) return true;
    remaining.set(title, count - 1);
  }
  return false;
}

/** Replay successful writes separately from pending arguments and task-list reads. */
export function successfulSessionPlanUpdate(
  messages: readonly ChatMessage[],
  result: { toolCallId: string; content?: string; isError?: boolean },
): { previous: TodoItem[]; plan: TodoItem[] } | null {
  if (result.isError) return null;
  const tool = flattenSessionMessages(messages).flatMap(message => message.toolCalls ?? [])
    .find(candidate => candidate.id === result.toolCallId);
  if (!tool) return null;
  if (result.content === undefined && tool.isError) return null;
  const content = result.content ?? tool.result;
  if (content === undefined) return null;
  const name = planToolName(tool.name);
  if (!/(updateplan|todowrite|writetodos|managetodolist|updatetodolist|setplan|todoadd|taskcreate|taskupdate|todoupdate)$/.test(name)) return null;
  if (typeof tool.arguments.operation === "string" && /^(read|list|get)$/i.test(tool.arguments.operation)) return null;

  const replay = (complete: boolean, items: readonly ChatMessage[]): ChatMessage[] => items.map(message => ({
    ...message,
    ...(message.toolCalls ? { toolCalls: message.toolCalls.flatMap(candidate => candidate.id !== result.toolCallId
      ? [candidate] : complete ? [{ ...candidate, result: content, isError: false }] : []) } : {}),
    ...(complete && message.role === "tool" && message.toolCallId === result.toolCallId
      ? { content, name: tool.name } : {}),
    ...(message.executionTrace ? { executionTrace: { ...message.executionTrace,
      liveMessages: replay(complete, message.executionTrace.liveMessages ?? []) } } : {}),
  }));
  const previous = sessionPlanSnapshot(replay(false, messages)) ?? [];
  const plan = sessionPlanSnapshot(replay(true, messages));
  return plan === null ? null : { previous, plan };
}

/** Only a successful plan addition can reveal the panel; individual task updates cannot. */
export function successfulSessionPlanAddition(
  messages: readonly ChatMessage[],
  result: { toolCallId: string; content?: string; isError?: boolean },
): TodoItem[] | null {
  const tool = flattenSessionMessages(messages).flatMap(message => message.toolCalls ?? [])
    .find(candidate => candidate.id === result.toolCallId);
  if (tool && /(taskupdate|todoupdate)$/.test(planToolName(tool.name))) return null;
  const update = successfulSessionPlanUpdate(messages, result);
  return update && hasSessionPlanAdditions(update.previous, update.plan) ? update.plan : null;
}
