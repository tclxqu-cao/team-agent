import { TodoError, type TodoCommand, type TodoDetail, type TodoExecutionTarget } from "@agent/core";
import { decodeUnifiedSessionId } from "@agent/native-runtime";

type Create = Extract<TodoCommand, { type: "create" }>;
type Schedule = Extract<TodoCommand, { type: "schedule" }>;
type TargetInput = Partial<TodoExecutionTarget>;
export type AgentTodoCommand = Exclude<TodoCommand, Create | Schedule>
  | (Omit<Create, "executionSchedule"> & {
    executionSchedule?: Omit<NonNullable<Create["executionSchedule"]>, "target"> & { target?: TargetInput };
  })
  | (Omit<Schedule, "target"> & { target?: TargetInput });

function mergeTarget(base: TodoExecutionTarget | undefined, input: TargetInput = {}): TodoExecutionTarget {
  const agentType = input.agentType ?? base?.agentType;
  const cwd = input.cwd ?? base?.cwd;
  if (!agentType || !cwd) throw new TodoError("INVALID_ARGUMENT", "缺少执行 Agent 或工作目录");
  const model = input.model ?? (agentType === base?.agentType ? base?.model : undefined);
  return { agentType, cwd, permissionMode: input.permissionMode ?? base?.permissionMode ?? "default", ...(model ? { model } : {}) };
}

/** Resolve omitted fields before saving the same concrete command used by the calendar. */
export async function resolveAgentTodoCommand(
  command: AgentTodoCommand,
  context: { sessionId?: string; cwd?: string; getTodo: (id: string) => TodoDetail },
): Promise<TodoCommand> {
  if (command?.type === "create" && command.executionSchedule) {
    const schedule = command.executionSchedule;
    const input = schedule.target ?? {};
    let cwd = context.cwd;
    let agentType: string | undefined;
    if ((!input.agentType || !input.cwd) && context.sessionId) {
      agentType = decodeUnifiedSessionId(context.sessionId).agentType;
      if (!input.cwd && !cwd && agentType !== "customer-agent") {
        const { getNativeRuntimeService } = await import("../native-runtime-service");
        cwd = (await getNativeRuntimeService().getSummary(context.sessionId)).cwd;
      }
    }
    const target = mergeTarget(undefined, { ...input, agentType: input.agentType ?? agentType, cwd: input.cwd ?? cwd });
    if (schedule.enabled !== false) {
      const { validateExecutionTarget } = await import("./scheduled-todo-runner");
      await validateExecutionTarget(target);
    }
    return { ...command, executionSchedule: { ...schedule, target } };
  }
  if (command?.type === "schedule") {
    const saved = context.getTodo(command.taskId).schedule?.target;
    const target = command.target ? mergeTarget(saved, command.target) : undefined;
    if (command.enabled) {
      const { validateExecutionTarget } = await import("./scheduled-todo-runner");
      await validateExecutionTarget(target ?? saved);
    }
    return { ...command, target };
  }
  return command as TodoCommand;
}
