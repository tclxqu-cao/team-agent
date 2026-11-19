import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TodoDetail } from "@agent/core";
import { encodeUnifiedSessionId } from "@agent/native-runtime";
import { resolveAgentTodoCommand, type AgentTodoCommand } from "./todo-agent-command";

const { getSummary, validate } = vi.hoisted(() => ({ getSummary: vi.fn(), validate: vi.fn() }));
vi.mock("../native-runtime-service", () => ({ getNativeRuntimeService: () => ({ getSummary }) }));
vi.mock("./scheduled-todo-runner", () => ({ validateExecutionTarget: validate }));

const trigger = { kind: "once", at: 1795100700000 } as const;
const target = { agentType: "zcode", cwd: "/repo", permissionMode: "acceptEdits", model: "zcode-model" } as const;
const getTodo = () => ({ schedule: { target } }) as TodoDetail;
const create: AgentTodoCommand = { type: "create", title: "定时调研", kind: "scheduled", executionSchedule: { trigger } };
const edit = { type: "schedule", taskId: "todo", expectedVersion: 2, enabled: true } as const;

describe("Todo commands issued by an agent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSummary.mockResolvedValue({ cwd: "/repo" });
    validate.mockResolvedValue(undefined);
  });

  it.each(["zcode", "codex", "workbuddy"] as const)("defaults the executable Todo to the %s source session", async engine => {
    const sessionId = encodeUnifiedSessionId(engine, "native");
    const concrete = { agentType: engine, cwd: "/repo", permissionMode: "default" };
    expect(await resolveAgentTodoCommand(create, { sessionId, getTodo }))
      .toMatchObject({ executionSchedule: { trigger, target: concrete } });
    expect(getSummary).toHaveBeenCalledWith(sessionId);
    expect(validate).toHaveBeenCalledWith(concrete);
  });

  it("keeps an explicit assignment and leaves a regular reminder alone", async () => {
    const context = { sessionId: encodeUnifiedSessionId("codex", "native"), getTodo };
    const explicit: AgentTodoCommand = { ...create, executionSchedule: { trigger, target } };
    expect(await resolveAgentTodoCommand(explicit, context)).toEqual(explicit);
    expect(getSummary).not.toHaveBeenCalled();
    const reminder: AgentTodoCommand = { type: "create", title: "提醒我", dueAt: trigger.at };
    expect(await resolveAgentTodoCommand(reminder, context)).toEqual(reminder);
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it("edits the time or the assignee independently and clears the old engine model on reassignment", async () => {
    expect(await resolveAgentTodoCommand({ ...edit, trigger }, { getTodo }))
      .toMatchObject({ trigger, expectedVersion: 2 });
    expect(validate).toHaveBeenLastCalledWith(target);
    const result = await resolveAgentTodoCommand({ ...edit, target: { agentType: "codex" } }, { getTodo });
    expect(result).toEqual({ ...edit, target: { agentType: "codex", cwd: "/repo", permissionMode: "acceptEdits" } });
  });

  it("fails when missing assignment fields cannot be resolved from a session", async () => {
    await expect(resolveAgentTodoCommand(create, { getTodo })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(validate).not.toHaveBeenCalled();
  });
});
