import {
  WEBAPP_BROWSER_EVENT_TYPE,
  parseWebBrowserBinaryFrame,
  WEBAPP_BROWSER_REQUEST_TYPE,
  parseWebBrowserEvent,
  parseWebBrowserResponse,
  type WebBrowserBinaryFrame,
  type WebBrowserMethod,
} from "../../../core/src/domain/web-console/WebBrowserBridge";
import type { BrowserLiveApi } from "../../../desktop/renderer/global";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: WebBrowserMethod;
};

type BridgeWindow = Pick<Window, "location" | "addEventListener" | "removeEventListener"> & {
  parent: Pick<Window, "postMessage">;
};

export class WebShellBrowserBridge implements BrowserLiveApi {
  private sequence = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Set<(event: Record<string, unknown> & { type: string }) => void>();
  private readonly sessionsByChannel = new Map<number, string>();
  private readonly pendingFramesByChannel = new Map<number, WebBrowserBinaryFrame>();
  private readonly onMessage: (event: MessageEvent) => void;

  constructor(
    private readonly context: BridgeWindow = window,
    private readonly timeoutMs = 15_000,
  ) {
    this.onMessage = (event) => {
      if (event.origin !== this.context.location.origin || event.source !== this.context.parent) return;
      const binaryFrame = parseWebBrowserBinaryFrame(event.data);
      if (binaryFrame) {
        const sessionId = this.sessionsByChannel.get(binaryFrame.channelId);
        if (!sessionId) {
          this.pendingFramesByChannel.set(binaryFrame.channelId, binaryFrame);
          return;
        }
        this.emitBinaryFrame(binaryFrame, sessionId);
        return;
      }
      const browserEvent = parseWebBrowserEvent(event.data);
      if (browserEvent) {
        for (const listener of this.listeners) listener(browserEvent.event);
        return;
      }
      const response = parseWebBrowserResponse(event.data);
      if (!response) return;
      const request = this.pending.get(response.id);
      if (!request) return;
      this.pending.delete(response.id);
      clearTimeout(request.timer);
      if (response.ok) {
        if (request.method === "browser:watch" && response.result && typeof response.result === "object") {
          const result = response.result as { channelId?: unknown; session?: { id?: unknown } };
          if (Number.isSafeInteger(result.channelId) && typeof result.session?.id === "string") {
            const channelId = Number(result.channelId);
            this.sessionsByChannel.set(channelId, result.session.id);
            const pendingFrame = this.pendingFramesByChannel.get(channelId);
            if (pendingFrame) {
              this.pendingFramesByChannel.delete(channelId);
              this.emitBinaryFrame(pendingFrame, result.session.id);
            }
          }
        }
        request.resolve(response.result);
      }
      else request.reject(Object.assign(new Error(response.error || "浏览器操作失败"), { code: response.code }));
    };
    this.context.addEventListener("message", this.onMessage as EventListener);
  }

  private emitBinaryFrame(frame: WebBrowserBinaryFrame, sessionId: string): void {
    for (const listener of this.listeners) listener({
      type: "browser:frame",
      sessionId,
      sequence: frame.sequence,
      data: frame.data,
      mime: "image/jpeg",
      timestamp: Date.now(),
    });
  }

  request<T>(method: WebBrowserMethod, payload: Record<string, unknown> = {}): Promise<T> {
    if ((this.context.parent as unknown) === this.context) {
      return Promise.reject(Object.assign(new Error("请从 AgentRoam Web 控制台打开浏览器直播"), { code: "WEB_SHELL_REQUIRED" }));
    }
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error("浏览器操作超时"), { code: "WEB_SHELL_TIMEOUT" }));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer, method });
      this.context.parent.postMessage({
        type: WEBAPP_BROWSER_REQUEST_TYPE,
        id,
        method,
        payload,
      }, this.context.location.origin);
    });
  }

  onEvent(listener: (event: Record<string, unknown> & { type: string }) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.context.removeEventListener("message", this.onMessage as EventListener);
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(Object.assign(new Error("浏览器桥已关闭"), { code: "WEB_SHELL_CLOSED" }));
    }
    this.pending.clear();
    this.listeners.clear();
    this.sessionsByChannel.clear();
    this.pendingFramesByChannel.clear();
  }
}
