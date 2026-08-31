"use client";
import type { ReactNode } from "react";
import { useWebAuth } from "./useWebAuth";

export type WebAuthController = ReturnType<typeof useWebAuth>;

/** Passwordless gate: only waits for the anonymous console bootstrap. */
export default function AuthGate({ children }: { children: (auth: WebAuthController) => ReactNode }) {
  const auth = useWebAuth();
  if (auth.status === "authenticated") return <>{children(auth)}</>;
  return (
    <main style={S.page}>
      <div style={S.card}>{auth.error || "正在连接远程控制台…"}</div>
    </main>
  );
}

const S: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100dvh",
    display: "grid",
    placeItems: "center",
    background: "#0b0b10",
    color: "#e8e8ee",
    fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
  },
  card: { color: "#858999", fontSize: 13 },
};
