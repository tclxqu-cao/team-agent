import { ServerEndpoint } from "./server-endpoint";

/** A QR invitation is deliberately different from a short manual pairing code. */
export function parsePairingQr(raw: string): { endpoint: ServerEndpoint; grant: string } {
  try {
    if (raw.length > 2048) throw new Error();
    if (!raw.startsWith("{")) {
      const url = new URL(raw);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/pair" || url.search || !/^#pair=[A-Za-z0-9_-]{43}$/.test(url.hash)) throw new Error();
      const endpoint = ServerEndpoint.parse(url.origin);
      if (!endpoint) throw new Error();
      return { endpoint, grant: url.hash.slice(6) };
    }
    const value = JSON.parse(raw);
    if (value.type !== "agentroam-pair" || value.version !== 1 || typeof value.server !== "string" || typeof value.grant !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.grant)) throw new Error();
    const url = new URL(value.server);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error();
    const endpoint = ServerEndpoint.parse(value.server);
    if (!endpoint) throw new Error();
    return { endpoint, grant: value.grant };
  } catch { throw new Error("这不是 AgentRoam 授权二维码，请扫描电脑终端上新生成的二维码。"); }
}
