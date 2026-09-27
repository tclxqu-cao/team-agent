import { isWebShell } from "../web/webLayout";

/**
 * Flow Studio 入口跳转：从服务端读取免登入口链接（AGENT_FLOW_STUDIO_ENTRY_URL）
 * 后打开新页签。免登录、默认页签等逻辑全部在 Flow Studio 侧（/auth/entry）处理，
 * 这里只负责把配置好的链接交给浏览器/系统浏览器。
 */

interface FlowStudioConfig {
  entryUrl?: string | null;
}

export async function resolveFlowStudioEntryUrl(): Promise<string | null> {
  try {
    if (isWebShell()) {
      const res = await fetch("/api/flow-studio/config", { credentials: "same-origin" });
      const body = await res.json() as FlowStudioConfig;
      return body.entryUrl ?? null;
    }
    // 桌面端渲染层不直连服务端：配置经既有 service IPC（带桌面 token）读取
    const service = window.sharedServiceApi;
    if (!service?.request) return null;
    const res = await service.request("/api/flow-studio/config", "GET");
    if (res.status !== 200) return null;
    return (JSON.parse(res.body) as FlowStudioConfig).entryUrl ?? null;
  } catch {
    return null;
  }
}

export async function openFlowStudioEntry(): Promise<boolean> {
  // 同步先开新页签保住用户手势（弹窗拦截器会拦异步 window.open），再异步取地址填入；
  // 拿不到入口地址时关掉空白页签。桌面端经 IPC 交给系统浏览器打开。
  if (isWebShell()) {
    const win = window.open("", "_blank");
    try {
      const entryUrl = await resolveFlowStudioEntryUrl();
      if (!entryUrl) { win?.close(); return false; }
      if (win) win.location.href = entryUrl;
      return true;
    } catch (error) {
      win?.close();
      throw error;
    }
  }
  const entryUrl = await resolveFlowStudioEntryUrl();
  if (!entryUrl) return false;
  await window.agentApi?.openExternal?.(entryUrl);
  return true;
}
