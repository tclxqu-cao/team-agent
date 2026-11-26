import { enqueueTodoCompletion, TodoError, type TodoListQuery } from "@agent/core";
import { authenticateTodoCredential, todoServiceId } from "../../../../lib/todo/todo-mcp-credentials";
import { todoServices } from "../../../../lib/todo/todo-service";
import { todoHttpError } from "../../../../lib/todo/todo-http";
import { resolveAgentTodoCommand, type AgentTodoCommand } from "../../../../lib/todo/todo-agent-command";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const c = authenticateTodoCredential(request.headers.get("x-agentroam-todo-credential"));
    const { operation, args = {} } = await request.json();
    const { todos, executions, notifications, uow, db } = todoServices();
    if (request.headers.get("x-agentroam-service-id") !== todoServiceId()) throw new TodoError("FORBIDDEN", "服务身份不匹配");
    if (operation === "identity") return Response.json({ serviceId: c.serviceId, scope: c.scope });
    if (c.scope === "relay") {
      if (operation === "bind_execution" && c.executionId && c.sessionId) return Response.json(executions.bind(c.ownerId, c.executionId, c.sessionId, args.runId));
      if (operation === "runtime_event") {
        if (typeof args.runId !== "string" || typeof args.event !== "object" || !c.sessionId) throw new TodoError("INVALID_ARGUMENT", "运行事件无效");
        const event = args.event;
        if (event.type === "approval_resolved") notifications.resolveApproval(c.ownerId, c.sessionId, event.questionId);
        else if (event.type === "ask_user") notifications.ingest({ ownerId: c.ownerId, sourceEventId: `${args.runId}:${event.questionId}:approval`, kind: "approval", sessionId: c.sessionId, taskId: c.executionId ? uow.run(tx => tx.todo_executions.get(c.ownerId, c.executionId!)?.taskId) : undefined, questionId: event.questionId, title: "需要你的确认", body: String(event.question ?? "会话等待审批或回答").slice(0, 500), createdAt: args.createdAt ?? Date.now() });
        else if (["done", "error", "turn_aborted"].includes(event.type)) {
          notifications.resolveApproval(c.ownerId, c.sessionId);
          if (c.executionId) executions.settle(c.ownerId, c.executionId, event.result?.status ?? "interrupted", event.message);
          else if (event.type === "done" && event.result?.status === "completed") {
            const source = args.completionSource;
            const report = args.completedWork; // Older brokers already extracted the titles.
            const startedAt = source?.startedAt ?? report?.startedAt;
            if (Number.isSafeInteger(startedAt) && startedAt <= args.createdAt) {
              const job = { ownerId: c.ownerId, sessionId: c.sessionId, runId: args.runId, startedAt };
              if (source && typeof source.input === "string" && typeof event.finalText === "string" && Array.isArray(source.plan)) {
                enqueueTodoCompletion(db, { ...job, evidence: { kind: "native", input: source.input, finalText: event.finalText, plan: source.plan } });
              } else if (Array.isArray(report?.titles) && report.titles.every((title: unknown) => typeof title === "string")) {
                enqueueTodoCompletion(db, { ...job, evidence: { kind: "reported", titles: report.titles } });
              }
            }
            notifications.ingest({ ownerId: c.ownerId, sourceEventId: `${args.runId}:completed`, kind: "completion", sessionId: c.sessionId, title: "会话已完成", body: String(event.finalText ?? "任务已完成").slice(0, 500), createdAt: args.createdAt ?? Date.now() });
          }
        }
        return Response.json({ ok: true });
      }
      throw new TodoError("FORBIDDEN", "运行凭据不允许此操作");
    }
    if (c.scope === "execution") {
      const e = uow.run(tx => tx.todo_executions.get(c.ownerId, c.executionId!));
      if (!e || !e.runId) throw new TodoError("FORBIDDEN", "执行尚未绑定");
      if (operation === "get" && (!args.taskId || args.taskId === e.taskId)) return Response.json({ task: todos.get(e.taskId, c.ownerId).task, execution: e, executions: [e], reminders: [], links: [] });
      if (operation === "report") return Response.json(executions.report(c.ownerId, e.id, e.runId, args.requestId, args.outcome, args.summary));
      throw new TodoError("FORBIDDEN", "该凭据只允许读取当前待办和报告当前执行");
    }
    if (operation === "get") return Response.json(todos.get(args.taskId, c.ownerId));
    if (operation === "list") return Response.json(todos.list(args as TodoListQuery, c.ownerId));
    if (operation === "execute") {
      const command = await resolveAgentTodoCommand(args.command as AgentTodoCommand, {
        sessionId: c.sessionId, getTodo: id => todos.get(id, c.ownerId),
      });
      return Response.json(todos.execute(command, { ownerId: c.ownerId, requestId: args.requestId, sourceSessionRef: c.sessionId }));
    }
    throw new TodoError("INVALID_ARGUMENT", "未知 MCP 操作");
  } catch (e) { return todoHttpError(e); }
}
