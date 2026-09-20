import type { AppEntry, DriverStatus, PhoneDriver, PressKey, ScreenSize } from "./types.js";
import { loadAppCatalog } from "../apps/catalog.js";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

interface WdaSession {
  sessionId: string;
}

export interface WdaDriverOptions {
  baseUrl?: string;
  prefix?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/**
 * iOS WebDriverAgent 驱动。前置条件：WDA 已构建到 iPhone 并在运行
 * （真机需 Xcode 开发者签名，默认 USB 下通过 iproxy 8100 暴露，见 README）。
 */
export class WdaDriver implements PhoneDriver {
  readonly kind = "wda" as const;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private sessionId: string | null = null;

  constructor(opts: WdaDriverOptions = {}) {
    const base = opts.baseUrl ?? "http://127.0.0.1:8100";
    const prefix = opts.prefix ?? "";
    this.baseUrl = `${base.replace(/\/$/, "")}${prefix}`;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const resp = await this.fetchImpl(this.url(path), {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`WDA ${init?.method ?? "GET"} ${path} 失败 HTTP ${resp.status}: ${body.slice(0, 300)}`);
    }
    const ct = resp.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      const json = (await resp.json()) as { value?: unknown } | unknown;
      return (json && typeof json === "object" && "value" in json ? (json as { value: T }).value : (json as T));
    }
    return (await resp.text()) as unknown as T;
  }

  private async session(): Promise<string> {
    if (this.sessionId) return this.sessionId;
    const value = await this.request<WdaSession | string>("/session", {
      method: "POST",
      body: JSON.stringify({ capabilities: {}, capabilitiesAlwaysMatch: {} }),
    });
    const id = typeof value === "string" ? value : value?.sessionId;
    if (!id) throw new Error("WDA /session 未返回 sessionId");
    this.sessionId = id;
    return id;
  }

  private async invalidateSession(): Promise<void> {
    this.sessionId = null;
  }

  /** 失效会话自动重建后重试一次。 */
  private async withSessionRetry<T>(fn: (sessionId: string) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.session());
    } catch (err) {
      await this.invalidateSession();
      return fn(await this.session());
    }
  }

  async status(): Promise<DriverStatus> {
    try {
      const info = await this.request<{ build?: { version?: string }; ios?: { ip?: string } }>("/status");
      return { ok: true, detail: `iOS WDA ready (build ${info?.build?.version ?? "?"}) ${this.baseUrl}` };
    } catch (err) {
      return {
        ok: false,
        detail: `WDA 不可达（${err instanceof Error ? err.message : String(err)}）。请先在 iPhone 上启动 WebDriverAgent 并 iproxy 转发 8100。`,
      };
    }
  }

  async screenSize(): Promise<ScreenSize> {
    const rect = await this.withSessionRetry((id) =>
      this.request<{ width: number; height: number }>(`/session/${id}/window/rect`),
    );
    return { width: rect.width, height: rect.height };
  }

  async screenshot(): Promise<Uint8Array> {
    const b64 = await this.withSessionRetry((id) =>
      this.request<string>(`/session/${id}/screenshot`),
    );
    return new Uint8Array(Buffer.from(b64, "base64"));
  }

  async uiTreeXml(): Promise<string> {
    const source = await this.withSessionRetry((id) => this.request<string>(`/session/${id}/source`));
    if (typeof source === "string") return source;
    // 某些 WDA 版本返回 { value: { xml: ... } } 或 JSON 树，兜底拿字符串
    return typeof (source as { xml?: string })?.xml === "string"
      ? (source as { xml: string }).xml
      : JSON.stringify(source);
  }

  private async actions(actions: unknown): Promise<void> {
    await this.withSessionRetry((id) =>
      this.request(`/session/${id}/actions`, { method: "POST", body: JSON.stringify({ actions }) }),
    );
  }

  private pointer(tools: Array<Record<string, unknown>>): unknown {
    return [
      {
        type: "pointer",
        id: "phone-agent-finger",
        parameters: { pointerType: "touch" },
        actions: tools,
      },
    ];
  }

  async tap(x: number, y: number): Promise<void> {
    const cx = Math.round(x);
    const cy = Math.round(y);
    await this.actions(
      this.pointer([
        { type: "pointerMove", duration: 0, x: cx, y: cy },
        { type: "pointerDown", button: 0 },
        { type: "pause", duration: 80 },
        { type: "pointerUp", button: 0 },
      ]),
    );
  }

  async swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<void> {
    const steps = 6;
    const tools: Array<Record<string, unknown>> = [
      { type: "pointerMove", duration: 0, x: Math.round(x1), y: Math.round(y1) },
      { type: "pointerDown", button: 0 },
    ];
    for (let i = 1; i <= steps; i++) {
      tools.push({
        type: "pointerMove",
        duration: Math.max(16, Math.round(durationMs / steps)),
        x: Math.round(x1 + ((x2 - x1) * i) / steps),
        y: Math.round(y1 + ((y2 - y1) * i) / steps),
      });
    }
    tools.push({ type: "pointerUp", button: 0 });
    await this.actions(this.pointer(tools));
  }

  async inputText(text: string): Promise<void> {
    // W3C key actions 不支持非 ASCII，中文走「定位输入框 + 设值」
    const hasNonAscii = /[^\x00-\x7F]/.test(text);
    if (hasNonAscii) {
      await this.typeIntoFocusedField(text);
      return;
    }
    const keys = [...text].map((ch) => (ch === " " ? " " : ch));
    await this.actions([
      {
        type: "key",
        id: "phone-agent-keyboard",
        actions: keys.map((ch) => ({ type: "key", value: ch })),
      },
    ]);
  }

  private async typeIntoFocusedField(text: string): Promise<void> {
    const el = await this.withSessionRetry(async (id) =>
      this.request<{ ELEMENT?: string; "element-6066-11e4-a52e-4f735466cecf"?: string }>(
        `/session/${id}/element`,
        {
          method: "POST",
          body: JSON.stringify({
            using: "-ios predicate string",
            value:
              "type == 'XCUIElementTypeTextField' OR type == 'XCUIElementTypeSearchField' OR type == 'XCUIElementTypeSecureTextField' OR type == 'XCUIElementTypeTextView'",
          }),
        },
      ),
    );
    const elementId = el?.ELEMENT ?? el?.["element-6066-11e4-a52e-4f735466cecf"];
    if (!elementId) throw new Error("当前屏幕没有可输入的文本框");
    await this.withSessionRetry((id) =>
      this.request(`/session/${id}/element/${elementId}/value`, {
        method: "POST",
        // 兼容 W3C（text）与旧协议（value 数组）
        body: JSON.stringify({ text, value: [text] }),
      }),
    );
  }

  async pressKey(key: PressKey): Promise<void> {
    if (key === "home") {
      await this.withSessionRetry((id) =>
        this.request(`/session/${id}/wda/pressButton`, {
          method: "POST",
          body: JSON.stringify({ name: "home" }),
        }),
      );
      return;
    }
    if (key === "enter") {
      await this.typeIntoFocusedField("\n");
      return;
    }
    throw new Error(`iOS WDA 不支持 ${key} 键（系统返回手势无法模拟），请改用 tap 坐标操作。`);
  }

  async launchApp(appId: string): Promise<void> {
    await this.withSessionRetry((id) =>
      this.request(`/session/${id}/wda/apps/launch`, {
        method: "POST",
        body: JSON.stringify({ bundleId: appId }),
      }),
    );
  }

  async listApps(): Promise<AppEntry[]> {
    // WDA 无已安装列表接口，退回 apps.json 里配置的 iOS 应用
    const catalog = loadAppCatalog();
    return catalog
      .filter((e) => e.ios)
      .map((e) => ({ id: e.ios!, name: e.name }));
  }

  async currentApp(): Promise<string> {
    const info = await this.withSessionRetry((id) =>
      this.request<{ bundleId?: string }>(`/session/${id}/wda/activeAppInfo`),
    );
    return info?.bundleId ?? "unknown";
  }
}
