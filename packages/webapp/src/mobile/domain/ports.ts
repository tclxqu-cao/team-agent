import type { ServerEndpoint } from "./server-endpoint";

/** 原生壳运行环境（Capacitor bridge）抽象，infrastructure 提供实现。 */
export interface NativeEnvironmentPort {
  /** true 表示运行在 Android/iOS 壳里；false 表示普通浏览器同源模式。 */
  isNativeApp(): boolean;
  /** 壳所属平台；web 模式恒为 "web"。 */
  platform(): "ios" | "android" | "web";
  /** 启动参数携带的服务器地址（如 ?server=192.168.1.10:3000），未携带时为 null。 */
  launchServerUrl(): string | null;
}

/** 连接基址的持久化端口（原生壳用 WebView localStorage 实现）。 */
export interface EndpointStoragePort {
  load(): ServerEndpoint | null;
  save(endpoint: ServerEndpoint): void;
  clear(): void;
}

export type ProbeResult =
  | { ok: true; modelId: string | null }
  | { ok: false; reason: string };

/** 连通性探测端口：对 {endpoint}/api/agent/model 发起带超时的 GET。 */
export interface ConnectivityProbePort {
  probe(endpoint: ServerEndpoint, timeoutMs?: number): Promise<ProbeResult>;
}
