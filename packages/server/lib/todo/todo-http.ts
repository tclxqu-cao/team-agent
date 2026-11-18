import { TodoError, type TodoCommand } from "@agent/core";
import { checkSharedWrite } from "../shared-write-request";
import { anonymousPrincipal } from "../web-auth/anonymous";
import { todoServices } from "./todo-service";
export function todoOwner(request: Request): string {
  // Set by the pairing gateway after credential validation, never trusted from
  // a browser. anonymousPrincipal supplies the shared workspace identity only.
  if (!request.headers.get("x-agentroam-device-id")) throw new TodoError("FORBIDDEN", "需要设备授权");
  return anonymousPrincipal().userId;
}
export function todoHttpError(error: unknown): Response {
  const status = error instanceof TodoError ? ({ INVALID_ARGUMENT: 400, NOT_FOUND: 404, FORBIDDEN: 403, VERSION_CONFLICT: 409, IDEMPOTENCY_CONFLICT: 409, BUSY: 409, UNAVAILABLE: 503 } as const)[error.code] : error instanceof SyntaxError ? 400 : 500;
  return Response.json({ error: status === 500 ? "待办服务暂不可用" : (error as Error).message, code: error instanceof TodoError ? error.code : status === 400 ? "INVALID_ARGUMENT" : "INTERNAL_ERROR" }, { status });
}
export async function todoWrite(request: Request, taskId?: string) {
  const rejected = checkSharedWrite(request); if (rejected) return rejected;
  try {
    const ownerId = todoOwner(request);
    const body = await request.json();
    if (!body || typeof body !== "object" || !body.command || typeof body.command !== "object") throw new TodoError("INVALID_ARGUMENT", "缺少待办操作");
    const command: TodoCommand = { ...body.command, ...(taskId ? { taskId } : {}) };
    if (!taskId && command.type !== "create") throw new TodoError("INVALID_ARGUMENT", "此入口只支持创建");
    if (command.type === "create" && command.executionSchedule?.enabled !== false && command.executionSchedule) {
      const { validateExecutionTarget } = await import("./scheduled-todo-runner");
      await validateExecutionTarget(command.executionSchedule.target);
    }
    if (command.type === "schedule" && command.enabled) {
      const { validateExecutionTarget } = await import("./scheduled-todo-runner");
      const target = command.target ?? todoServices().todos.get(taskId!, ownerId).schedule?.target;
      await validateExecutionTarget(target);
    }
    return Response.json(todoServices().todos.execute(command, { ownerId, requestId: body.requestId }));
  } catch (error) { return todoHttpError(error); }
}
