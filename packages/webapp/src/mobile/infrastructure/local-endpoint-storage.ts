import type { EndpointStoragePort } from "../domain/ports";
import { ServerEndpoint } from "../domain/server-endpoint";

const STORAGE_KEY = "webapp.mobile.serverEndpoint.v1";

/** localStorage 适配器：跨重启记住最近一次成功连接的服务器。 */
export class LocalEndpointStorage implements EndpointStoragePort {
  load(): ServerEndpoint | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? ServerEndpoint.parse(raw) : null;
    } catch {
      return null;
    }
  }

  save(endpoint: ServerEndpoint): void {
    localStorage.setItem(STORAGE_KEY, endpoint.toString());
  }

  clear(): void {
    localStorage.removeItem(STORAGE_KEY);
  }
}
