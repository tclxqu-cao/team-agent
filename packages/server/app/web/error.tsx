"use client";

export default function WebError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main role="alert" style={{ padding: 32, fontFamily: "system-ui", lineHeight: 1.8 }}>
      <h1>页面加载失败</h1>
      <p>请重试；如果仍无法打开，请检查网络，并确认电脑上的 AgentRoam 正在运行。</p>
      <button type="button" onClick={reset}>重试</button>{" "}
      <button type="button" onClick={() => window.location.reload()}>刷新页面</button>
    </main>
  );
}
