const str = { type: "string" }, num = { type: "integer", minimum: 0 };
const trigger = { oneOf: [{ type: "object", properties: { kind: { const: "once" }, at: num }, required: ["kind", "at"], additionalProperties: false }, { type: "object", properties: { kind: { const: "cron" }, expression: str }, required: ["kind", "expression"], additionalProperties: false }] };
const target = { type: "object", properties: { agentType: str, model: str, cwd: str, permissionMode: { enum: ["default", "acceptEdits", "bypassPermissions"] } }, additionalProperties: false };
const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[]) => ({ name, description, inputSchema: { type: "object" as const, properties, required, additionalProperties: false } });
const existing = { taskId: str, expectedVersion: num, requestId: str };
export const TODO_TOOL_INSTRUCTIONS = "这些工具管理 AgentRoam 日历中可见的个人待办，跨会话和 Agent 持久保存，与会话临时计划、Wiki 工作线程不同。用户要求创建个人待办或日历待办时，使用 todo_create。要求到点执行时，创建 scheduled 待办并启用执行计划，使用本工具集，不调用引擎原生 CronCreate。创建时省略 target 会交给发起会话的 Agent。只有用户明确指定时才另选 Agent。改派或改时间时先用 todo_get 获取版本，再用 todo_schedule 提交变更。不要把 Wiki 待办、Markdown 文件或会话计划当作已同步到 AgentRoam 日历。只有工具成功返回待办 ID 才能确认创建；无日期的待办显示在日历的未安排区域。写操作必须使用稳定唯一 requestId，重试同一操作沿用原值。更新前 todo_get 取得 version。普通待办只提醒；只有显式 scheduled 类型并启用执行计划才自动启动 Agent。普通待办仅按用户操作或明确管理指令更新；用户明确说完成可 todo_complete，明确开始可 todo_start。定时执行凭据必须 todo_report_execution 报告，不能完成整个周期事项。";
export const TODO_TOOLS = [
  tool("todo_create", `创建独立个人待办，可在同一事务设置提醒和执行计划。有未来日期默认在该时刻提醒；reminder=null 可关闭默认提醒。${TODO_TOOL_INSTRUCTIONS}`, { title: str, description: str, kind: { enum: ["normal", "scheduled"] }, dueAt: num, timeZone: str, reminder: { anyOf: [trigger, { type: "null" }] }, executionSchedule: { type: "object", properties: { trigger, target, timeZone: str, enabled: { type: "boolean" } }, required: ["trigger"], additionalProperties: false }, scheduleRef: str, projectId: str, requestId: str }, ["title", "requestId"]),
  tool("todo_get", "读取待办、version、提醒、执行计划和最近十次执行；执行凭据只读取本次待办。", { taskId: str }, ["taskId"]),
  tool("todo_list", "列出 AgentRoam 日历中跨会话的个人待办；不扫描 Wiki 待办或会话临时计划。", { status: { enum: ["pending", "in_progress", "completed", "failed", "cancelled"] }, kind: { enum: ["normal", "scheduled"] }, limit: num, cursor: str }, []),
  tool("todo_update", "修改标题、描述、日期或项目；dueAt=null 移除日期。", { ...existing, patch: { type: "object", properties: { title: str, description: str, dueAt: { type: ["integer", "null"] }, projectId: str }, additionalProperties: false } }, [...Object.keys(existing), "patch"]),
  ...(["start", "complete", "cancel", "reopen"] as const).map(action => tool(`todo_${action}`, { start: "标记实际已开始的待办为进行中。", complete: "确认完成后打勾并停用自有提醒/执行计划。", cancel: "取消待办并停止未来提醒/执行。", reopen: "重新打开；不会自动恢复旧提醒或旧执行计划。" }[action], existing, Object.keys(existing))),
  tool("todo_remind", "设置一次性/五字段 cron 提醒，timeZone 默认 Asia/Shanghai；trigger=null 停止提醒。不会启动 Agent。", { ...existing, trigger: { anyOf: [trigger, { type: "null" }] }, timeZone: str }, [...Object.keys(existing), "trigger"]),
  tool("todo_link_schedule", "关联外部定时任务的稳定 scheduleRef，仅关联，不启动、不停止外部任务。", { ...existing, scheduleRef: str, label: str }, [...Object.keys(existing), "scheduleRef"]),
  tool("todo_schedule", "修改 scheduled 待办的执行计划。改派时只传 target.agentType，改时间时只传 trigger，保留其他设置。一次性触发使用毫秒时间戳。保留现有 enabled 状态，除非用户要求启用或暂停。", { ...existing, enabled: { type: "boolean" }, trigger, timeZone: str, target }, [...Object.keys(existing), "enabled"]),
  tool("todo_report_execution", "报告当前定时执行的进度或最终结果。进度回报和最终回报各使用独立的 requestId。运行成功结束后才会结算。", {
    requestId: { ...str, description: "使用定时执行指令给出的对应编号。只有原样重试同一份回报时才复用该编号。" },
    outcome: { enum: ["progress", "succeeded", "failed"] },
    summary: str,
  }, ["requestId", "outcome", "summary"]),
];
export function todoToolOperation(name: string, input: Record<string, unknown>) {
  if (!TODO_TOOLS.some(t => t.name === name)) throw new Error("Unknown Todo tool");
  if (name === "todo_get") return { operation: "get", args: input };
  if (name === "todo_list") return { operation: "list", args: input };
  if (name === "todo_report_execution") return { operation: "report", args: input };
  const { requestId, ...rest } = input;
  const type = name === "todo_link_schedule" ? "linkSchedule" : name.slice(5);
  return { operation: "execute", args: { command: { ...rest, type }, requestId } };
}
