"use client";
import { useState, type ReactNode } from "react";
import { useWebAuth } from "./useWebAuth";

export type WebAuthController = ReturnType<typeof useWebAuth>;

export default function AuthGate({ children }: { children: (auth: WebAuthController) => ReactNode }) {
  const auth = useWebAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  if (auth.status === "authenticated") return <>{children(auth)}</>;
  if (auth.status === "loading") return <main style={S.page}><div style={S.card}>正在加载…</div></main>;

  const isSetup = auth.status === "needsSetup";
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true);
    try { await (isSetup ? auth.setup(username, password) : auth.login(username, password)); }
    finally { setBusy(false); }
  };

  return (
    <main style={S.page}>
      <form style={S.card} onSubmit={submit}>
        <div style={S.mark}>CA</div>
        <h1 style={S.title}>{isSetup ? "初始化管理员" : "登录远程控制台"}</h1>
        <p style={S.copy}>{isSetup ? "创建唯一管理员账号。完成后初始化入口将关闭。" : "登录后 30 天内自动续期，无需再次输入 token。"}</p>
        <label style={S.label}>用户名</label>
        <input style={S.input} autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required minLength={3} />
        <label style={S.label}>密码</label>
        <input style={S.input} type="password" autoComplete={isSetup ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} />
        {auth.error && <div style={S.error}>{auth.error}</div>}
        <button style={S.button} disabled={busy}>{busy ? "请稍候…" : isSetup ? "创建并进入" : "登录"}</button>
      </form>
    </main>
  );
}

const S: Record<string, React.CSSProperties> = {
  page: { minHeight: "100dvh", display: "grid", placeItems: "center", padding: 20, boxSizing: "border-box", background: "#0b0b10", color: "#e8e8ee", fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif' },
  card: { width: "min(380px,100%)", padding: 24, border: "1px solid #292c36", borderRadius: 12, background: "#14161d", boxSizing: "border-box", boxShadow: "0 18px 50px rgba(0,0,0,.35)" },
  mark: { width: 40, height: 40, display: "grid", placeItems: "center", borderRadius: 8, background: "#7aa2f7", color: "#0b0b10", fontWeight: 800, marginBottom: 16 },
  title: { margin: "0 0 8px", fontSize: 20, letterSpacing: 0 }, copy: { margin: "0 0 20px", color: "#858999", fontSize: 12.5, lineHeight: 1.6 },
  label: { display: "block", color: "#9a9ead", fontSize: 11, margin: "12px 0 6px" }, input: { width: "100%", height: 40, boxSizing: "border-box", border: "1px solid #343844", borderRadius: 7, padding: "0 10px", background: "#0e1016", color: "#eceef4", fontSize: 14, outline: "none" },
  error: { marginTop: 12, color: "#f7768e", fontSize: 12 }, button: { width: "100%", height: 40, marginTop: 18, border: 0, borderRadius: 7, background: "#7aa2f7", color: "#0b0b10", fontWeight: 700, fontSize: 13 },
};
