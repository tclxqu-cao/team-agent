import { isAbsolute } from "node:path";
import { stat } from "node:fs/promises";
import { TodoError, type TodoExecutionTarget, type NativeAgentType } from "@agent/core";
import { TODO_NATIVE_INJECTION_SUPPORT } from "@agent/native-runtime";
import { getNativeRuntimeService } from "../native-runtime-service";
import { todoServices } from "./todo-service";
import { createRuntimeTodoContext } from "./runtime-todo-context";
export async function validateExecutionTarget(target?: TodoExecutionTarget): Promise<void> {
  if (!target || !isAbsolute(target.cwd) || !await stat(target.cwd).then(s => s.isDirectory()).catch(() => false)) throw new TodoError("INVALID_ARGUMENT", "执行工作目录必须是存在的绝对路径");
  if (!["session", "launch", "command-bridge"].includes(TODO_NATIVE_INJECTION_SUPPORT[target.agentType as NativeAgentType])) throw new TodoError("UNAVAILABLE", "此 Agent 尚未通过个人待办工具接入验证，请选择支持个人待办工具的 Agent");
  const runtime = getNativeRuntimeService();
  const health = (await runtime.health()).find(h => h.agentType === target.agentType);
  if (!health?.available) throw new TodoError("UNAVAILABLE", health?.error ?? "目标 Agent 不可用");
  if (target.model && !(await runtime.listModels(target.agentType as NativeAgentType)).some(m => m.id === target.model)) throw new TodoError("INVALID_ARGUMENT", "目标 Agent 未提供此模型");
}
export async function dispatchScheduledTodos(): Promise<void> {
  const { executions, todos, uow } = todoServices();
  const pending = executions.pending();
  if (!pending.length) return;
  const runtime = getNativeRuntimeService();
  for (let e of pending) {
    const task = todos.get(e.taskId, e.ownerId).task;
    if (task.activeExecutionId !== e.id || task.controlRevision !== e.controlRevision || ["completed", "cancelled"].includes(task.status)) {
      if (e.sessionId) await runtime.abort(e.sessionId).catch(() => undefined);
      executions.settle(e.ownerId, e.id, "cancelled"); continue;
    }
    try {
      if (!e.sessionId) {
        // A dedicated occurrence never continues the user's source chat.
        const session = await runtime.create({ agentType: e.target.agentType as NativeAgentType, title: `定时待办 · ${task.title}`, cwd: e.target.cwd, todoContext: createRuntimeTodoContext(undefined, e.id, e.target.model) });
        e = executions.bind(e.ownerId, e.id, session.id);
        await runtime.setPermissionMode(session.id, e.target.permissionMode === "bypassPermissions" ? "full-access" : e.target.permissionMode === "acceptEdits" ? "auto-approval" : "request-approval");
      }
      const snapshot = await runtime.messageSnapshot(e.sessionId!, e.id);
      if (!snapshot.item) {
        // Broker admission deduplicates the durable occurrence id, even if the
        // enqueue response was lost before the service could record runId.
        await runtime.enqueueMessage(e.sessionId!, {
          sourceMessageId: e.id,
          content: [
            `执行本次定时待办（taskId=${task.id}，executionId=${e.id}）。`,
            `标题：${task.title}`,
            task.description,
            `先用 todo_get 读取事项。开始时调用 todo_report_execution，outcome=progress，requestId="${e.id}:progress"。`,
            `确认业务完成且有证据后报告 succeeded，否则报告 failed。最终回报的 requestId="${e.id}:result"。`,
            "只有原样重试同一份回报时才复用它的 requestId。必须报告本次执行结果，不能调用 todo_complete 完成整个周期事项。",
          ].join("\n"),
        });
      } else if (snapshot.runId) {
        executions.bind(e.ownerId, e.id, e.sessionId!, snapshot.runId);
        const terminal = snapshot.events.map(x => x.event).find(x => ["done", "error", "turn_aborted"].includes(x.type));
        if (terminal && (terminal.type === "done" || terminal.type === "error" || terminal.type === "turn_aborted")) executions.settle(e.ownerId, e.id, terminal.result?.status ?? "interrupted", "message" in terminal ? String(terminal.message) : undefined);
        else if (snapshot.runStatus === "active") uow.run(tx => { const current = tx.todo_executions.get(e.ownerId, e.id), status = snapshot.events.some(x => x.event.type === "ask_user") ? "waiting_for_human" : "running"; if (current && ["running", "waiting_for_human"].includes(current.status) && current.status !== status) tx.todo_executions.put({ ...current, status }); });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "执行派发失败";
      uow.run(tx => { const current = tx.todo_executions.get(e.ownerId, e.id); if (current && ["queued", "running", "waiting_for_human"].includes(current.status)) tx.todo_executions.put({ ...current, error: message }); });
      // A temporary service/broker outage must leave an admitted execution for
      // reconciliation, not dispatch the business a second time.
      if (!e.sessionId) executions.settle(e.ownerId, e.id, "failed", message);
    }
  }
}
