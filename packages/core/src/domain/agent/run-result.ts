import type { AgentEvent, TokenUsage } from './entities.js';

export type RunStatus = "completed" | "failed" | "cancelled" | "interrupted";

export type RunReasonCode =
  | "completed"
  | "user_cancelled"
  | "auth_required"
  | "quota_exceeded"
  | "rate_limited"
  | "permission_denied"
  | "context_limit"
  | "output_limit"
  | "timeout"
  | "network_error"
  | "runtime_unavailable"
  | "provider_error"
  | "runtime_interrupted"
  | "protocol_error"
  | "iteration_limit"
  | "tool_cycle"
  | "unknown_error";

export interface RunResult {
  status: RunStatus;
  reason: RunReasonCode;
  durationMs: number;
  runId?: string;
  usage?: TokenUsage;
}

export type RunTerminalEvent = Extract<AgentEvent, { type: "done" | "error" | "turn_aborted" }>;

const REASON_LABELS: Record<RunReasonCode, string> = {
  completed: "已完成",
  user_cancelled: "用户已停止",
  auth_required: "需要重新登录或检查凭据",
  quota_exceeded: "额度不足",
  rate_limited: "请求过于频繁",
  permission_denied: "权限被拒绝",
  context_limit: "上下文超出限制",
  output_limit: "输出达到限制",
  timeout: "请求超时",
  network_error: "网络连接失败",
  runtime_unavailable: "运行环境不可用",
  provider_error: "模型服务异常",
  runtime_interrupted: "运行环境中断",
  protocol_error: "运行协议异常",
  iteration_limit: "已达到执行轮数限制",
  tool_cycle: "已停止重复的工具调用",
  unknown_error: "原因未识别，请查看错误详情",
};

export function normalizeTokenUsage(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as Partial<TokenUsage>;
  const valid = (count: unknown): count is number => (
    typeof count === "number" && Number.isSafeInteger(count) && count >= 0
  );
  if (!valid(usage.inputTokens) || !valid(usage.outputTokens)) return undefined;
  const totalTokens = usage.inputTokens + usage.outputTokens;
  if (!Number.isSafeInteger(totalTokens)) return undefined;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens,
    ...(valid(usage.cacheReadTokens) && usage.cacheReadTokens <= usage.inputTokens
      ? { cacheReadTokens: usage.cacheReadTokens } : {}),
    ...(valid(usage.cacheWriteTokens) && usage.cacheWriteTokens <= usage.inputTokens
      ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
    ...(usage.source === "provider" || usage.source === "runtime" ? { source: usage.source } : {}),
    ...(usage.coverage === "complete" || usage.coverage === "partial" ? { coverage: usage.coverage } : {}),
  };
}

export function classifyRunError(message: string, code?: string): Exclude<RunReasonCode, "completed"> {
  const text = `${code ?? ""}\n${message}`;
  if (/\b(?:native_aborted|user_aborted|user_cancelled|run_cancelled)\b/i.test(code ?? "")) return "user_cancelled";
  if (/insufficient[_\s-]*quota|quota[_\s-]*(?:exceeded|exhausted)|out of (?:credits|quota)|credit balance|usage limit|billing|额度.*(?:不足|耗尽|用尽|超限)|余额不足|套餐.*(?:不足|耗尽|用尽)/i.test(text)) return "quota_exceeded";
  if (/\b401\b|http_401|unauthori[sz]ed|authentication|auth[_\s-]*(?:required|expired|failed)|invalid[_\s-]*(?:api[_\s-]*)?(?:key|token)|not logged in|login required|sign[ -]?in required|登录.*(?:失效|过期)|未登录/i.test(text)) return "auth_required";
  if (/\b429\b|http_429|rate[_\s-]*limit|too many requests|限流|请求.*频繁/i.test(text)) return "rate_limited";
  if (/\b403\b|http_403|permission[_\s-]*(?:denied|rejected)|access[_\s-]*denied|forbidden|tool_(?:policy|approval)_(?:denied|rejected)|权限.*(?:拒绝|不足)|审批.*拒绝/i.test(text)) return "permission_denied";
  if (/context[_\s-]*(?:limit|length|window)|maximum context|上下文.*(?:限制|上限|超)/i.test(text)) return "context_limit";
  if (/max[_\s-]*tokens|output[_\s-]*limit|输出.*(?:截断|限制|上限)/i.test(text)) return "output_limit";
  if (/iteration[_\s-]*limit|max[_\s-]*turns|执行轮数/i.test(text)) return "iteration_limit";
  if (/repeated_tool_cycle|重复.*工具/i.test(text)) return "tool_cycle";
  if (/timeout|timed out|etimedout|超时/i.test(text)) return "timeout";
  if (/runtime[_\s-]*(?:restarted|interrupted)|(?:runtime|broker|process|connection|transport|socket).*(?:restarted|interrupted|disconnected|closed|exited)|\bturn was interrupted\b|服务.*重启|运行.*中断/i.test(text)) return "runtime_interrupted";
  if (/econn(?:refused|reset)|enotfound|eai_again|fetch failed|network[_\s-]*(?:error|failed|unavailable)|网络.*(?:失败|异常|不可用)/i.test(text)) return "network_error";
  if (/runtime[_\s-]*unavailable|engine[_\s-]*unavailable|enoent|cli.*not found|executable.*not found|运行.*不可用/i.test(text)) return "runtime_unavailable";
  if (/protocol[_\s-]*error|invalid.*json|malformed|tool_arguments_(?:invalid|incomplete)|协议.*异常/i.test(text)) return "protocol_error";
  if (/MODEL_HTTP_5\d{2}|\b(?:api|http)\b.*\b5\d{2}\b|overloaded|service unavailable|服务.*(?:过载|暂不可用)/i.test(text)) return "provider_error";
  return "unknown_error";
}

export function createRunResult(event: RunTerminalEvent, options: {
  durationMs: number;
  runId?: string;
  cancelled?: boolean;
}): RunResult {
  const reason: RunReasonCode = options.cancelled || event.type === "turn_aborted"
    ? "user_cancelled"
    : event.type === "error"
      ? classifyRunError(event.message, event.code)
      : event.result?.reason ?? "completed";
  const status: RunStatus = reason === "user_cancelled" ? "cancelled"
    : reason === "runtime_interrupted" ? "interrupted"
      : event.type === "done" ? event.result?.status ?? "completed" : "failed";
  const usage = normalizeTokenUsage(event.usage ?? event.result?.usage);
  return {
    status,
    reason,
    durationMs: Number.isFinite(options.durationMs) ? Math.max(0, Math.round(options.durationMs)) : 0,
    ...(options.runId ? { runId: options.runId } : {}),
    ...(usage ? { usage } : {}),
  };
}

export function runResultLabel(result: RunResult): string {
  const reason = REASON_LABELS[result.reason] ?? REASON_LABELS.unknown_error;
  if (result.status === "cancelled") return "已停止";
  if (result.status === "interrupted") return "已中断：运行环境中断";
  if (result.status === "failed") return `运行失败：${reason}`;
  return result.reason === "completed" ? "已完成" : `已结束：${reason}`;
}
