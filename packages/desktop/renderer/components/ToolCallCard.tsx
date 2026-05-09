import { useState } from "react";

interface ToolCallProps {
  toolCall: {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
    result?: string;
    isError?: boolean;
  };
}

export default function ToolCallCard({ toolCall }: ToolCallProps) {
  const [expanded, setExpanded] = useState(false);

  const statusColor = toolCall.result
    ? (toolCall.isError ? "var(--danger)" : "var(--success)")
    : "var(--accent)";

  const statusBg = toolCall.result
    ? (toolCall.isError ? "rgba(220,38,38,0.07)" : "rgba(5,150,105,0.07)")
    : "var(--accent-dim)";

  const borderColor = toolCall.result
    ? (toolCall.isError ? "rgba(220,38,38,0.18)" : "rgba(5,150,105,0.18)")
    : "var(--border-default)";

  return (
    <div style={{
      marginTop: 10,
      borderRadius: 10,
      border: `1px solid ${borderColor}`,
      overflow: "hidden",
      fontSize: 12,
      background: "var(--bg-deepest)",
      transition: "border-color 0.25s",
    }}>
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          width: "100%",
          padding: "9px 12px",
          background: statusBg,
          border: "none",
          cursor: "pointer",
          textAlign: "left",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          fontFamily: "var(--font-body)",
          transition: "filter 0.15s",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.filter = "brightness(0.96)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.filter = "brightness(1)"; }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {/* Wrench icon */}
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={statusColor} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
          </svg>
          <span style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11.5,
            color: statusColor,
            fontWeight: 600,
            letterSpacing: "0.01em",
          }}>
            {toolCall.name}
          </span>
          {/* Status badge */}
          <span style={{
            fontSize: 10,
            padding: "1px 7px",
            borderRadius: 20,
            background: toolCall.result
              ? (toolCall.isError ? "rgba(220,38,38,0.1)" : "rgba(5,150,105,0.1)")
              : "rgba(79,110,247,0.1)",
            color: statusColor,
            fontWeight: 500,
          }}>
            {toolCall.result ? (toolCall.isError ? "错误" : "完成") : "执行中"}
          </span>
        </span>
        {/* Chevron */}
        <svg
          width="13" height="13" viewBox="0 0 24 24" fill="none"
          stroke="var(--text-muted)" strokeWidth="2.5" strokeLinecap="round"
          style={{ transition: "transform 0.3s var(--ease-out)", transform: expanded ? "rotate(180deg)" : "rotate(0deg)", flexShrink: 0 }}
        >
          <path d="m6 9 6 6 6-6"/>
        </svg>
      </button>

      {/* Expandable body */}
      <div style={{
        overflow: "hidden",
        maxHeight: expanded ? 800 : 0,
        opacity: expanded ? 1 : 0,
        transition: "max-height 0.4s cubic-bezier(0.4,0,0.2,1), opacity 0.3s ease",
      }}>
        <div style={{
          padding: "12px 14px",
          borderTop: `1px solid ${borderColor}`,
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}>
          {/* Arguments */}
          <div>
            <div style={{
              fontSize: 10,
              color: "var(--text-muted)",
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.07em",
              marginBottom: 6,
            }}>
              参数
            </div>
            <pre style={{
              fontSize: 11,
              color: "var(--text-secondary)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
              fontFamily: "var(--font-mono)",
              padding: "10px 12px",
              borderRadius: 8,
              background: "var(--bg-surface)",
              border: "1px solid var(--border-subtle)",
              margin: 0,
              lineHeight: 1.6,
            }}>
              {JSON.stringify(toolCall.arguments, null, 2)}
            </pre>
          </div>

          {/* Result */}
          {toolCall.result && (
            <div>
              <div style={{
                fontSize: 10,
                color: "var(--text-muted)",
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.07em",
                marginBottom: 6,
              }}>
                {toolCall.isError ? "错误信息" : "返回结果"}
              </div>
              <pre style={{
                fontSize: 11,
                color: toolCall.isError ? "var(--danger)" : "var(--text-secondary)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
                fontFamily: "var(--font-mono)",
                padding: "10px 12px",
                borderRadius: 8,
                background: toolCall.isError ? "rgba(220,38,38,0.04)" : "var(--bg-surface)",
                border: `1px solid ${toolCall.isError ? "rgba(220,38,38,0.15)" : "var(--border-subtle)"}`,
                borderLeft: `3px solid ${toolCall.isError ? "var(--danger)" : "var(--success)"}`,
                maxHeight: 240,
                overflow: "auto",
                margin: 0,
                lineHeight: 1.6,
              }}>
                {toolCall.result}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
