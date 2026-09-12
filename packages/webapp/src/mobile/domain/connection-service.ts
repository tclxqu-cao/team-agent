import type { ConnectivityProbePort, EndpointStoragePort, NativeEnvironmentPort } from "./ports";
import { ServerEndpoint } from "./server-endpoint";

/**
 * 移动端启动时连接基址的解析结果：
 * - same-origin：浏览器模式，一切保持既有同源行为；
 * - ready：原生壳且已有可信基址，直接以该基址启动；
 * - setup：原生壳但没有可用基址（首次启动或探活失败），展示连接页。
 */
export type ConnectionPlan =
  | { mode: "same-origin" }
  | { mode: "ready"; endpoint: ServerEndpoint }
  | { mode: "setup"; endpoint: ServerEndpoint | null; failure?: string };

/**
 * 「移动端服务器连接」领域服务：只编排端口，不感知 localStorage/fetch/Capacitor。
 * 基址优先级：启动参数 > 已存基址（须探活通过）> 进入 setup。
 */
export class MobileConnectionService {
  constructor(
    private readonly environment: NativeEnvironmentPort,
    private readonly storage: EndpointStoragePort,
    private readonly probe: ConnectivityProbePort,
  ) {}

  async planStartup(): Promise<ConnectionPlan> {
    if (!this.environment.isNativeApp()) return { mode: "same-origin" };

    const launch = this.launchEndpoint();
    if (launch) return { mode: "ready", endpoint: launch };

    const saved = this.storage.load();
    if (saved) {
      const result = await this.probe.probe(saved);
      if (result.ok) return { mode: "ready", endpoint: saved };
      return { mode: "setup", endpoint: saved, failure: result.reason };
    }
    return { mode: "setup", endpoint: null };
  }

  /** 连接页提交：校验 + 探活 + 持久化，通过才允许进入主界面。 */
  async connect(rawInput: string): Promise<{ ok: true; endpoint: ServerEndpoint } | { ok: false; reason: string }> {
    const endpoint = ServerEndpoint.parse(rawInput);
    if (!endpoint) return { ok: false, reason: "地址无效，请输入 http(s)://host:port 形式的服务器地址" };
    const result = await this.probe.probe(endpoint);
    if (!result.ok) return { ok: false, reason: `无法连接服务器：${result.reason}` };
    this.storage.save(endpoint);
    return { ok: true, endpoint };
  }

  /** 用户主动切换/退出当前服务器。 */
  disconnect(): void {
    this.storage.clear();
  }

  private launchEndpoint(): ServerEndpoint | null {
    const raw = this.environment.launchServerUrl();
    return raw ? ServerEndpoint.parse(raw) : null;
  }
}
