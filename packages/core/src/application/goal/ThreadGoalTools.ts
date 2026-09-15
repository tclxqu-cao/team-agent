// ── Thread Goal Model Tools ──
// 给模型的三个目标工具：create_goal / get_goal / update_goal。
// update_goal 只允许 complete/blocked/paused；resume 与预算类状态归用户和系统管。
import { z } from "zod";
import type { ITool, ToolContext, ToolResult } from '../../domain/tool/entities.js';
import { THREAD_GOAL_OBJECTIVE_MAX_LENGTH, type ThreadGoalStatus } from '../../domain/goal/ThreadGoal.js';
import type { ThreadGoalService } from './ThreadGoalService.js';

export class CreateGoalTool implements ITool {
  readonly name = "create_goal";
  readonly description =
    "为当前会话创建一个持久化目标（每个会话只能有一个）。创建后目标模式开启：每轮对话结束后，" +
    "系统会在会话空闲时自动注入目标上下文并开始下一轮，持续推进该目标，直到目标被标记完成/受阻、" +
    "token 预算耗尽或用户暂停。只在用户明确要求持续 autonomous 推进某个目标时使用；" +
    "若会话已有目标，请改用 get_goal 查看并用 update_goal 或让用户调整。";
  readonly schema = z.object({
    objective: z.string().min(1).max(THREAD_GOAL_OBJECTIVE_MAX_LENGTH).describe("目标描述（用户视角的成果，不超过 4000 字）"),
    token_budget: z.number().int().positive().optional().describe("可选 token 预算上限；耗尽后自动停止续跑"),
  });
  readonly parameters = {
    type: "object",
    properties: {
      objective: { type: "string", description: "目标描述（用户视角的成果，不超过 4000 字）" },
      token_budget: { type: "integer", description: "可选 token 预算上限；耗尽后自动停止续跑" },
    },
    required: ["objective"],
  };

  constructor(private readonly service: ThreadGoalService, private readonly sessionId: string) {}

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const parsed = this.schema.safeParse(params);
    if (!parsed.success) return { toolCallId: "", content: `Invalid arguments: ${parsed.error.message}`, isError: true };
    const existing = await this.service.getGoal(resolveSessionId(ctx, this.sessionId));
    if (existing && (existing.status === "active" || existing.status === "paused")) {
      return {
        toolCallId: "",
        content: `当前会话已有目标（状态 ${existing.status}）：${existing.objective}。请用 get_goal 查看，如需更换目标请让用户操作。`,
        isError: true,
      };
    }
    try {
      const goal = await this.service.setGoal(resolveSessionId(ctx, this.sessionId), parsed.data.objective, { tokenBudget: parsed.data.token_budget ?? null });
      return { toolCallId: "", content: `目标已创建并激活：${goal.objective}${goal.tokenBudget !== null ? `（token 预算 ${goal.tokenBudget}）` : ""}。本轮结束后系统将自动续跑推进该目标。` };
    } catch (error) {
      return { toolCallId: "", content: `Failed to create goal: ${error instanceof Error ? error.message : String(error)}`, isError: true };
    }
  }
}

export class GetGoalTool implements ITool {
  readonly name = "get_goal";
  readonly description = "查看当前会话的目标模式状态：目标文本、状态（active/paused/blocked/usage_limited/budget_limited/complete）、token 用量与预算、续跑轮数。";
  readonly schema = z.object({});
  readonly parameters = { type: "object", properties: {}, required: [] };

  constructor(private readonly service: ThreadGoalService, private readonly sessionId: string) {}

  async execute(_params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const goal = await this.service.getGoal(resolveSessionId(ctx, this.sessionId));
    if (!goal) return { toolCallId: "", content: "当前会话没有目标。可用 create_goal 创建。" };
    return {
      toolCallId: "",
      content: JSON.stringify({
        objective: goal.objective,
        status: goal.status,
        token_budget: goal.tokenBudget,
        tokens_used: goal.tokensUsed,
        remaining_tokens: goal.tokenBudget === null ? null : Math.max(0, goal.tokenBudget - goal.tokensUsed),
        time_used_seconds: Math.round(goal.timeUsedSeconds),
        turn_count: goal.turnCount,
        updated_at: goal.updatedAt,
      }, null, 2),
    };
  }
}

export class UpdateGoalTool implements ITool {
  readonly name = "update_goal";
  readonly description =
    "更新当前目标的状态。只允许：complete（已完成——必须先逐条找到证据证明目标达成）、" +
    "blocked（受阻——连续 3 轮无进展后才可使用，需说明原因）、paused（主动暂停，等待用户）。" +
    "resume 与预算类状态不能通过本工具设置。标记 complete 前请对照目标逐条核对证据，防止偷工减料。";
  readonly schema = z.object({
    status: z.enum(["complete", "blocked", "paused"]),
    reason: z.string().optional().describe("状态变更原因（complete 的达成证据、blocked 的阻塞原因）"),
  });
  readonly parameters = {
    type: "object",
    properties: {
      status: { type: "string", enum: ["complete", "blocked", "paused"], description: "目标新状态" },
      reason: { type: "string", description: "状态变更原因" },
    },
    required: ["status"],
  };

  constructor(private readonly service: ThreadGoalService, private readonly sessionId: string) {}

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const parsed = this.schema.safeParse(params);
    if (!parsed.success) return { toolCallId: "", content: `Invalid arguments: ${parsed.error.message}`, isError: true };
    try {
      const goal = await this.service.applyModelStatusUpdate(resolveSessionId(ctx, this.sessionId), parsed.data.status as ThreadGoalStatus);
      return {
        toolCallId: "",
        content: `目标已标记为 ${goal.status}。${parsed.data.reason ? `原因：${parsed.data.reason}` : ""}${
          goal.status === "complete" ? "目标模式停止自动续跑。" : goal.status === "paused" ? "等待用户恢复。" : "等待用户处理阻塞后恢复。"
        }`,
      };
    } catch (error) {
      return { toolCallId: "", content: `Failed to update goal: ${error instanceof Error ? error.message : String(error)}`, isError: true };
    }
  }
}

/** 工具优先用当前 run 的会话（ctx.sessionId），注册时捕获的只是兜底值。 */
function resolveSessionId(ctx: ToolContext, fallback: string): string {
  return ctx.sessionId || fallback;
}

export function createThreadGoalTools(service: ThreadGoalService, sessionId: string): ITool[] {
  return [
    new CreateGoalTool(service, sessionId),
    new GetGoalTool(service, sessionId),
    new UpdateGoalTool(service, sessionId),
  ];
}
