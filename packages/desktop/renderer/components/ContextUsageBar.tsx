import { useMemo, useRef, useState } from "react";
import type {
  ContextUsageCategory,
  ContextUsageSnapshot,
} from "../stores/agentStore";

type ContextUsageGroupKey = "system" | "messages" | "tools" | "images" | "overhead";

interface SegmentMeta {
  label: string;
  group: ContextUsageGroupKey;
}

interface GroupMeta {
  label: string;
  color: string;
}

const CATEGORY_META: Record<ContextUsageCategory, SegmentMeta> = {
  systemBase: { label: "系统基础提示", group: "system" },
  environment: { label: "运行环境", group: "system" },
  projectContext: { label: "项目上下文", group: "system" },
  skills: { label: "技能指令", group: "system" },
  memory: { label: "Memory", group: "system" },
  embeddedTools: { label: "系统内嵌工具定义", group: "system" },
  conversationHistory: { label: "历史用户消息", group: "messages" },
  currentUserMessage: { label: "当前用户消息", group: "messages" },
  assistantMessages: { label: "AI 历史回复", group: "messages" },
  compactionSummary: { label: "上下文压缩摘要", group: "messages" },
  toolCalls: { label: "工具调用", group: "tools" },
  toolResults: { label: "工具结果", group: "tools" },
  nativeToolDefinitions: { label: "原生工具定义", group: "tools" },
  images: { label: "图片", group: "images" },
  messageOverhead: { label: "协议与消息开销", group: "overhead" },
};

const GROUP_META: Record<ContextUsageGroupKey, GroupMeta> = {
  system: { label: "系统", color: "#8b5cf6" },
  messages: { label: "消息", color: "#4f6ef7" },
  tools: { label: "工具", color: "#f59e0b" },
  images: { label: "图片", color: "#ec4899" },
  overhead: { label: "协议开销", color: "#94a3b8" },
};

const GROUP_ORDER: ContextUsageGroupKey[] = ["system", "messages", "tools", "images", "overhead"];

export interface ContextUsageView {
  hasUsage: boolean;
  totalTokens: number;
  maxTokens: number;
  ratio: number;
  percent: number;
  groups: Array<{ key: ContextUsageGroupKey; label: string; color: string; tokens: number }>;
  details: Array<{ category: ContextUsageCategory; label: string; color: string; tokens: number }>;
  requestLabel?: string;
}

export function buildContextUsageView(
  usage: ContextUsageSnapshot | undefined,
  contextWindowK: number,
): ContextUsageView {
  const maxTokens = usage?.maxTokens ?? Math.max(1, contextWindowK * 1000);
  const totalTokens = usage?.totalTokens ?? 0;
  const groupTotals = Object.fromEntries(GROUP_ORDER.map((key) => [key, 0])) as Record<ContextUsageGroupKey, number>;

  for (const segment of usage?.segments ?? []) {
    const meta = CATEGORY_META[segment.category];
    if (meta) groupTotals[meta.group] += segment.tokens;
  }

  const ratio = Math.min(totalTokens / maxTokens, 1);
  return {
    hasUsage: !!usage,
    totalTokens,
    maxTokens,
    ratio,
    percent: Math.round(ratio * 100),
    groups: GROUP_ORDER.map((key) => ({
      key,
      label: GROUP_META[key].label,
      color: GROUP_META[key].color,
      tokens: groupTotals[key],
    })),
    details: (usage?.segments ?? [])
      .filter((segment) => segment.tokens > 0)
      .map((segment) => ({
        category: segment.category,
        label: CATEGORY_META[segment.category]?.label ?? segment.category,
        color: GROUP_META[CATEGORY_META[segment.category]?.group ?? "overhead"].color,
        tokens: segment.tokens,
      })),
    requestLabel: usage
      ? `${usage.providerId} · ${usage.modelId} · 第 ${usage.requestIndex} 次请求`
      : undefined,
  };
}

function formatTokens(tokens: number): string {
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(tokens >= 10_000 ? 0 : 1)}K`;
  return `${tokens}`;
}

export default function ContextUsageBar({
  usage,
  contextWindowK,
}: {
  usage?: ContextUsageSnapshot;
  contextWindowK: number;
}) {
  const [open, setOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const view = useMemo(() => buildContextUsageView(usage, contextWindowK), [usage, contextWindowK]);
  const barColor = view.ratio >= 0.85 ? "var(--danger)" : view.ratio >= 0.6 ? "#f59e0b" : "var(--accent)";
  const viewportWidth = typeof window === "undefined" ? 1024 : window.innerWidth;

  return (
    <div className="context-usage-ribbon" style={{ position: "relative", borderBottom: "1px solid var(--border-subtle)" }}>
      <button
        className="context-usage-ribbon__button"
        ref={buttonRef}
        type="button"
        onClick={() => {
          const rect = buttonRef.current?.getBoundingClientRect() ?? null;
          setAnchorRect(rect);
          setOpen((v) => !v);
        }}
        title="查看完整请求上下文占用估算"
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
        <span className="context-usage-ribbon__label" style={{ fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap" }}>上下文</span>
        <div className="context-usage-ribbon__meter" style={{
          flex: 1,
          height: 6,
          borderRadius: 999,
          overflow: "hidden",
          background: "rgba(0,0,0,0.06)",
          display: "flex",
        }}>
          {view.groups.map((group) => (
            <div
              key={group.key}
              style={{
                width: `${Math.max(0, Math.min((group.tokens / view.maxTokens) * 100, 100))}%`,
                background: group.color,
                opacity: group.key === "overhead" ? 0.65 : 1,
                minWidth: group.tokens > 0 ? 1 : 0,
              }}
            />
          ))}
        </div>
        <span className="context-usage-ribbon__summary" style={{ fontSize: 11, color: view.hasUsage ? barColor : "var(--text-muted)", fontVariantNumeric: "tabular-nums", minWidth: 110, textAlign: "right" }}>
          {view.hasUsage
            ? `${formatTokens(view.totalTokens)} / ${formatTokens(view.maxTokens)} · ${view.percent}%`
            : "尚无模型请求"}
        </span>
      </button>

      {open && anchorRect && (
        <>
          <div
            onClick={() => setOpen(false)}
            style={{ position: "fixed", inset: 0, zIndex: 9998, background: "transparent" }}
          />
          <div style={{
            position: "fixed",
            left: Math.max(8, anchorRect.left),
            top: anchorRect.top - 8,
            transform: "translateY(-100%)",
            width: Math.min(anchorRect.width, viewportWidth - 16),
            maxHeight: "min(520px, calc(100vh - 32px))",
            overflowY: "auto",
            zIndex: 9999,
            padding: 12,
            borderRadius: 12,
            background: "var(--bg-surface)",
            border: "1px solid var(--border-subtle)",
            boxShadow: "var(--shadow-lg)",
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)" }}>完整请求上下文估算</div>
              <div style={{ fontSize: 11, color: view.hasUsage ? barColor : "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>
                {view.hasUsage ? `${view.percent}%` : "暂无"}
              </div>
            </div>
            {view.requestLabel && (
              <div style={{ marginBottom: 10, fontSize: 10, color: "var(--text-muted)", wordBreak: "break-all" }}>
                {view.requestLabel}
              </div>
            )}
            {view.hasUsage ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                {view.details.map((segment) => {
                  const segmentPercent = view.totalTokens > 0 ? Math.round((segment.tokens / view.totalTokens) * 100) : 0;
                  return (
                    <div key={segment.category} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ width: 8, height: 8, borderRadius: "50%", background: segment.color }} />
                      <span style={{ flex: 1, fontSize: 12, color: "var(--text-secondary)" }}>{segment.label}</span>
                      <span style={{ fontSize: 12, color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>
                        {formatTokens(segment.tokens)} · {segmentPercent}%
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div style={{ padding: "8px 0", fontSize: 12, color: "var(--text-muted)" }}>
                发送第一条消息后，将显示最新一次模型请求的完整上下文组成。
              </div>
            )}
            <div style={{ marginTop: 10, fontSize: 11, lineHeight: 1.5, color: "var(--text-muted)" }}>
              基于最新一次实际发送前请求的完整组成估算，包含系统提示、环境、项目上下文、技能、memory、历史消息、工具定义/调用/结果、图片和压缩摘要。不同模型的 tokenizer 与协议存在差异，因此不是账单精确值。
            </div>
          </div>
        </>
      )}
    </div>
  );
}
