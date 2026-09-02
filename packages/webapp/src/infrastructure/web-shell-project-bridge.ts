import {
  WEBAPP_PROJECT_REQUEST_TYPE,
  parseWebProjectResponse,
  type WebProjectMethod,
} from "../../../core/src/domain/web-console/WebProjectBridge";

export interface WebProjectBridge {
  request<T>(method: WebProjectMethod, payload?: Record<string, unknown>): Promise<T>;
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type BridgeWindow = Pick<Window, "location" | "addEventListener" | "removeEventListener"> & {
  parent: Pick<Window, "postMessage">;
};

export class WebShellProjectBridge implements WebProjectBridge {
  private sequence = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly onMessage: (event: MessageEvent) => void;

  constructor(
    private readonly context: BridgeWindow = window,
    private readonly timeoutMs = 15_000,
  ) {
    this.onMessage = (event) => {
      if (event.origin !== this.context.location.origin || event.source !== this.context.parent) return;
      const response = parseWebProjectResponse(event.data);
      if (!response) return;
      const request = this.pending.get(response.id);
      if (!request) return;
      this.pending.delete(response.id);
      clearTimeout(request.timer);
      if (response.ok) request.resolve(response.result);
      else request.reject(Object.assign(new Error(response.error || "项目操作失败"), { code: response.code }));
    };
    this.context.addEventListener("message", this.onMessage as EventListener);
  }

  request<T>(method: WebProjectMethod, payload: Record<string, unknown> = {}): Promise<T> {
    if ((this.context.parent as unknown) === this.context) {
      return Promise.reject(Object.assign(
        new Error("请从 AgentRoam Web 控制台打开项目"),
        { code: "WEB_SHELL_REQUIRED" },
      ));
    }
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error("项目操作超时"), { code: "WEB_SHELL_TIMEOUT" }));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.context.parent.postMessage({
        type: WEBAPP_PROJECT_REQUEST_TYPE,
        id,
        method,
        payload,
      }, this.context.location.origin);
    });
  }

  dispose(): void {
    this.context.removeEventListener("message", this.onMessage as EventListener);
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(Object.assign(new Error("项目桥已关闭"), { code: "WEB_SHELL_CLOSED" }));
    }
    this.pending.clear();
  }
}
