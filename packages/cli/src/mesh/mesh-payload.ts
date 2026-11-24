import { hostname } from "node:os";

/**
 * 纯函数层（无子进程、无二维码依赖），便于在 CLI 之外复用与单测：
 * 机器标识、扫码载荷、本机服务地址发现。
 */

/** 机器标识：与 headscale user 命名一一对应（agentroam-<id>）。 */
export function meshMachineId(host: string = hostname()): string {
  return host.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/g, "") || "local";
}

/** 手机扫码载荷：JSON，官方客户端 M2 手工输入，M3 内嵌客户端直接解析。 */
export function meshQrPayload(input: { loginServer: string; authkey: string; expiresAt?: string | null; accessUrl?: string }): string {
  return JSON.stringify({
    type: "agentroam-mesh",
    version: 1,
    loginServer: input.loginServer,
    authkey: input.authkey,
    ...(input.accessUrl ? { accessUrl: input.accessUrl } : {}),
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
  });
}
