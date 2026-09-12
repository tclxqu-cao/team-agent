import { useState } from "react";
import type { MobileConnectionService } from "../domain/connection-service";
import type { ServerEndpoint } from "../domain/server-endpoint";

interface ConnectionScreenProps {
  service: MobileConnectionService;
  savedEndpoint: ServerEndpoint | null;
  initialFailure?: string;
  onConnected: (endpoint: ServerEndpoint) => void;
}

/**
 * 移动端连接页：原生壳首次启动或上次服务器失联时出现。
 * 输入 AgentRoam 服务端地址（如 http://192.168.1.10:3000），探活通过后进入主界面。
 */
export function ConnectionScreen({ service, savedEndpoint, initialFailure, onConnected }: ConnectionScreenProps) {
  const [input, setInput] = useState(savedEndpoint?.toString() ?? "");
  const [error, setError] = useState(initialFailure ?? "");
  const [busy, setBusy] = useState(false);

  async function handleConnect() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await service.connect(input);
      if (result.ok) onConnected(result.endpoint);
      else setError(result.reason);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <div style={styles.icon}>🛰️</div>
        <h1 style={styles.title}>连接服务器</h1>
        <p style={styles.hint}>
          输入运行 AgentRoam 服务端的机器地址（含端口），
          手机需与本机处于同一网络。
        </p>
        <input
          style={styles.input}
          value={input}
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="http://192.168.1.10:3000"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleConnect();
          }}
        />
        {error ? <p style={styles.error}>{error}</p> : null}
        <button style={{ ...styles.button, opacity: busy || !input.trim() ? 0.6 : 1 }} disabled={busy} onClick={() => void handleConnect()}>
          {busy ? "正在连接…" : "连接"}
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100dvh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "#f5f6fa",
    padding: 24,
    boxSizing: "border-box",
  },
  card: {
    width: "100%",
    maxWidth: 420,
    background: "#fff",
    borderRadius: 16,
    padding: "32px 24px",
    boxShadow: "0 8px 32px rgba(0,0,0,0.08)",
    textAlign: "center",
  },
  icon: { fontSize: 40, marginBottom: 8 },
  title: { fontSize: 20, margin: "0 0 8px", color: "#1c1e26" },
  hint: { fontSize: 13, lineHeight: 1.6, color: "#6b7280", margin: "0 0 20px" },
  input: {
    width: "100%",
    boxSizing: "border-box",
    padding: "12px 14px",
    fontSize: 16,
    borderRadius: 10,
    border: "1px solid #d6d9e0",
    outline: "none",
    marginBottom: 12,
  },
  error: { fontSize: 13, color: "#dc2626", margin: "0 0 12px", textAlign: "left" },
  button: {
    width: "100%",
    padding: "12px 0",
    fontSize: 16,
    fontWeight: 600,
    color: "#fff",
    background: "#4f6ef7",
    border: "none",
    borderRadius: 10,
    cursor: "pointer",
  },
};
