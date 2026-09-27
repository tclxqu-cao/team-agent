// Flow Studio 免登入口地址下发：桌面端/web 控制台的 Flow 按钮据此跳转。
// 入口链接（含 token）完全由 AGENT_FLOW_STUDIO_ENTRY_URL 配置，
// 免登录、默认页签等逻辑都在 Flow Studio 侧（/auth/entry）处理。
// 未配置时返回 null，前端按钮保持静默。

export async function GET(): Promise<Response> {
  const raw = (process.env.AGENT_FLOW_STUDIO_ENTRY_URL || "").trim();
  let entryUrl: string | null = null;
  try {
    const parsed = new URL(raw);
    entryUrl = parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    entryUrl = null;
  }
  return Response.json({ entryUrl }, { headers: { "cache-control": "no-store" } });
}
