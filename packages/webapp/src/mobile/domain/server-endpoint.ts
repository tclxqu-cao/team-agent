/**
 * 移动端「服务器连接」限界上下文 · 领域层
 *
 * ServerEndpoint 是一个值对象：原生壳（Android/iOS）里资源从 capacitor://localhost
 * 加载，所有 /api/* 相对路径都会打到本地壳而不是真正的 AgentRoam 服务端，
 * 因此连接必须落在一个显式的、经过校验的绝对基址上。浏览器（web）模式没有
 * 这个问题，保持同源相对路径即可。
 */
export class ServerEndpoint {
  private constructor(readonly url: string) {}

  /** 归一化并校验用户输入；非法输入返回 null，而不是抛异常打断 UI 流程。 */
  static parse(input: string): ServerEndpoint | null {
    const trimmed = input.trim();
    if (!trimmed) return null;
    const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (!parsed.hostname) return null;
    // 基址只保留 scheme://host:port，路径与查询串一律丢弃，避免拼接 /api 时歧义。
    return new ServerEndpoint(`${parsed.protocol}//${parsed.host}`);
  }

  toString(): string {
    return this.url;
  }

  /** 领域不变式：拼接 API 路径的唯一入口，保证不会出现双斜杠。 */
  api(path: string): string {
    return `${this.url}${path.startsWith("/") ? path : `/${path}`}`;
  }
}
