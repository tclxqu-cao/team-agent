import type { ReactNode } from "react";
import { runErrorRecoveryKind } from "../lib/session-run-error";

interface RunFailureNoticeProps {
  message: string;
  historical?: boolean;
  onSwitchModel?: () => void;
  children?: ReactNode;
}

export default function RunFailureNotice({ message, historical, onSwitchModel, children }: RunFailureNoticeProps) {
  const recovery = runErrorRecoveryKind(message);
  const title = recovery === "model" ? "模型请求失败" : recovery === "connection" ? "连接失败" : "操作失败";
  return (
    <div role="alert" style={{
      padding: 12, margin: "8px 0", borderRadius: "var(--radius-sm)",
      background: "rgba(248,113,113,0.08)", border: "1px solid rgba(248,113,113,0.2)",
      color: "var(--danger)", fontSize: 13, animation: "fadeIn 0.2s var(--ease-out)",
      display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10,
    }}>
      <div style={{ flex: "1 1 240px", minWidth: 0, overflowWrap: "anywhere" }}>
        <strong>{historical ? "上次执行失败 · " : ""}{title}</strong>
        <div style={{ marginTop: 4, whiteSpace: "pre-wrap", fontFamily: "var(--font-mono)" }}>{message}</div>
        {recovery === "model" && (
          <div style={{ marginTop: 6 }}>可以切换下方模型，再手动继续；不会自动重试。</div>
        )}
        {recovery === "connection" && (
          <div style={{ marginTop: 6 }}>请先检查执行服务连接再重试，切换模型不能解决此连接错误。</div>
        )}
      </div>
      {recovery === "model" && onSwitchModel && (
        <button type="button" onClick={onSwitchModel} style={{
          flexShrink: 0, minHeight: 32, padding: "5px 10px", borderRadius: 5,
          border: "1px solid rgba(248,113,113,0.35)", background: "var(--bg-workspace)",
          color: "var(--danger)", cursor: "pointer", fontSize: 12,
        }}>切换模型</button>
      )}
      {children}
    </div>
  );
}
