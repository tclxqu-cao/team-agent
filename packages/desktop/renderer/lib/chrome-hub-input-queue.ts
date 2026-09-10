import type { ChromeHubInput } from "../../main/ai-hub/chrome-bridge-protocol";

/** Keep clicks/text ordered while replacing unsent motion with the latest position. */
export function createChromeInputQueue(dispatch: (input: ChromeHubInput) => Promise<unknown>, onError: (error: unknown) => void, onSuccess: () => void) {
  const pending: ChromeHubInput[] = [];
  let running = false;
  let disposed = false;
  const drain = async () => {
    if (running || disposed) return;
    running = true;
    try {
      while (pending.length && !disposed) {
        const input = pending.shift()!;
        try { await dispatch(input); if (!disposed) onSuccess(); }
        catch (error) { if (!disposed) onError(error); }
      }
    } finally { running = false; }
  };
  return {
    push(input: ChromeHubInput) {
      if (disposed) return;
      const last = pending[pending.length - 1];
      if (input.kind === "pointer" && last?.kind === "pointer" && input.action === last.action && ["move", "wheel"].includes(input.action)) {
        pending[pending.length - 1] = input.action === "wheel"
          ? { ...input, deltaX: Math.max(-100_000, Math.min(100_000, (last.deltaX ?? 0) + (input.deltaX ?? 0))), deltaY: Math.max(-100_000, Math.min(100_000, (last.deltaY ?? 0) + (input.deltaY ?? 0))) }
          : input;
      } else pending.push(input);
      void drain();
    },
    dispose() { disposed = true; pending.length = 0; },
  };
}

export function chromeInputError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("chrome-auth-required")) return "页面需要登录，请在 Chrome 完成后重新连接";
  if (message.includes("chrome-page-loading")) return "页面正在加载，请稍后重试";
  if (message.includes("超时") || message.includes("chrome-command-timeout")) return "页面操作超时，请稍后重试";
  if (message.includes("断开") || message.includes("连接该站点")) return "Chrome 标签页已断开，请在扩展中重新连接";
  return "本次页面操作未成功，请重试；可在 Chrome 检查页面";
}
