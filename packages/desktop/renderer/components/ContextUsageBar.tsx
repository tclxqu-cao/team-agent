import { useMemo, useState } from "react";
import type { ChatMessage } from "../stores/agentStore";

export interface ContextUsageSegment {
  key: "user" | "assistant" | "tools" | "overhead";
  label: string;
  tokens: number;
  color: string;
}

export interface ContextUsageEstimate {
  totalTokens: number;
  maxTokens: number;
  ratio: number;
  segments: ContextUsageSegment[];
}

const SEGMENT_META: Record<ContextUsageSegment["key"], { label: string; color: string }> = {
  user: { label: "用户消息", color: "#4f6ef7" },
  assistant: { label: "AI 回复", color: "#34d399" },
  tools: { label: "工具调用/结果", color: "#f59e0b" },
  overhead: { label: "系统估算开销", color: "#94a3b8" },
};

function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function formatTokens(tokens: number): string {
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(tokens >= 10_000 ? 0 : 1)}K`;
  return `${tokens}`;
}

export function estimateContextUsage(messages: ChatMessage[], contextWindowK: number): ContextUsageEstimate {
  const totals: Record<ContextUsageSegment["key"], number> = {
    user: 0,
    assistant: 0,
    tools: 0,
    overhead: 0,
  };

  for (const message of messages) {
    if (message.isQueued) continue;
    if (message.role === "user") {
      totals.user += estimateTextTokens(message.content);
      totals.user += (message.images?.length ?? 0) * 1000;
      continue;
    }
    if (message.role === "assistant") {
      totals.assistant += estimateTextTokens(message.content);
      for (const toolCall of message.toolCalls ?? []) {
        totals.tools += estimateTextTokens(toolCall.name);
        totals.tools += estimateTextTokens(JSON.stringify(toolCall.arguments ?? {}));
        totals.tools += estimateTextTokens(toolCall.result ?? "");
      }
      if (message.askUser) {
        totals.tools += estimateTextTokens(message.askUser.question);
      }
      if (message.widget) {
        totals.tools += estimateTextTokens(JSON.stringify(message.widget.data ?? {}));
      }
    }
  }

  const hasConversationContent = totals.user + totals.assistant + totals.tools > 0;
  totals.overhead = hasConversationContent ? 2000 : 0;

  const maxTokens = Math.max(1, contextWindowK * 1000);
  const segments = (Object.keys(totals) as ContextUsageSegment["key"][]).map((key) => ({
    key,
    label: SEGMENT_META[key].label,
    color: SEGMENT_META[key].color,
    tokens: totals[key],
  }));
  const totalTokens = segments.reduce((sum, segment) => sum + segment.tokens, 0);
  return {
    totalTokens,
    maxTokens,
    ratio: Math.min(totalTokens / maxTokens, 1),
    segments,
  };
}

export default function ContextUsageBar({
  messages,
  contextWindowK,
}: {
  messages: ChatMessage[];
  contextWindowK: number;
}) {
  const [open, setOpen] = useState(false);
  const estimate = useMemo(() => estimateContextUsage(messages, contextWindowK), [messages, contextWindowK]);
  const percent = Math.round(estimate.ratio * 100);
  const barColor = estimate.ratio >= 0.85 ? "var(--danger)" : estimate.ratio >= 0.6 ? "#f59e0b" : "var(--accent)";

  return (
    <div style={{ position: "relative", borderBottom: "1px solid var(--border-subtle)" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="查看上下文占用估算"
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "6px 10px",
          border: 0,
          background: "transparent",
          cursor: "pointer",
          fontFamily: "var(--font-body)",
        }}
      >
        <span style={{ fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap" }}>上下文</span>
        <div style={{
          flex: 1,
          height: 6,
          borderRadius: 999,
          overflow: "hidden",
          background: "rgba(0,0,0,0.06)",
          display: "flex",
        }}>
          {estimate.segments.map((segment) => {
            const width = estimate.totalTokens > 0 ? (segment.tokens / estimate.maxTokens) * 100 : 0;
            return (
              <div
                key={segment.key}
                style={{
                  width: `${Math.max(0, Math.min(width, 100))}%`,
                  background: segment.key === "overhead" ? "rgba(148,163,184,0.55)" : segment.color,
                  minWidth: segment.tokens > 0 ? 1 : 0,
                }}
              />
            );
          })}
        </div>
        <span style={{ fontSize: 11, color: barColor, fontVariantNumeric: "tabular-nums", minWidth: 74, textAlign: "right" }}>
          {formatTokens(estimate.totalTokens)} / {formatTokens(estimate.maxTokens)} · {percent}%
        </span>
      </button>

      {open && (
        <div style={{
          position: "absolute",
          left: 10,
          right: 10,
          top: "calc(100% + 8px)",
          zIndex: 30,
          padding: 12,
          borderRadius: 12,
          background: "var(--bg-surface)",
          border: "1px solid var(--border-subtle)",
          boxShadow: "var(--shadow-lg)",
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)" }}>上下文占用估算</div>
            <div style={{ fontSize: 11, color: barColor, fontVariantNumeric: "tabular-nums" }}>{percent}%</div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            {estimate.segments.map((segment) => {
              const segmentPercent = estimate.totalTokens > 0 ? Math.round((segment.tokens / estimate.totalTokens) * 100) : 0;
              return (
                <div key={segment.key} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: segment.color, opacity: segment.key === "overhead" ? 0.65 : 1 }} />
                  <span style={{ flex: 1, fontSize: 12, color: "var(--text-secondary)" }}>{segment.label}</span>
                  <span style={{ fontSize: 12, color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>
                    {formatTokens(segment.tokens)} · {segmentPercent}%
                  </span>
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: 10, fontSize: 11, lineHeight: 1.5, color: "var(--text-muted)" }}>
            这是基于当前可见消息的粗略估算；实际请求还会包含系统提示、工具定义、技能、项目上下文和 memory。
          </div>
        </div>
      )}
    </div>
  );
}
