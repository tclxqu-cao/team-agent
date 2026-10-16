import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const QRCode = require("qrcode-terminal/vendor/QRCode");

export interface MobilePairingInvitation {
  svg: string;
  origin: string;
  pairingUrl: string;
  expiresAt: number;
}

export function pairingOrigin(raw: string): string {
  const url = new URL(raw.trim());
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || !["/", "/web"].includes(url.pathname) || ["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(url.hostname)) {
    throw new Error("手机访问地址无效，请先启动 AgentRoam CLI 的手机访问连接。");
  }
  return url.origin;
}

export async function readMobilePairingOrigin(dataDir: string): Promise<string> {
  // CLI's server uses <data-dir>/data; a standalone server uses dataDir itself.
  let origin: string | undefined;
  for (const path of [join(dataDir, "tunnel.url"), join(dataDir, "..", "tunnel.url")]) {
    try { origin = pairingOrigin(await readFile(path, "utf8")); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  if (!origin) throw new Error("尚未建立手机访问连接，请先运行 agentroam，再重新打开二维码。");
  return origin;
}

/** Invitation generation stays in main; the renderer never receives the local admin token. */
export async function createMobilePairingInvitation(
  dataDir: string,
  request: () => Promise<{ status: number; body: string }>,
): Promise<MobilePairingInvitation> {
  const origin = await readMobilePairingOrigin(dataDir);
  const response = await request();
  if (response.status !== 200) throw new Error(response.status === 423 ? "远程访问已锁定，请先在电脑上解锁。" : "生成二维码失败，请检查 AgentRoam 服务后重试。");
  const { grant, expiresAt } = JSON.parse(response.body);
  if (typeof grant !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(grant) || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new Error("服务器未返回有效的授权二维码，请重试。");
  }
  const pairingUrl = `${origin}/pair#pair=${grant}`;
  const qr = new QRCode(-1, 1);
  qr.addData(pairingUrl);
  qr.make();
  const count = qr.getModuleCount();
  const cells: string[] = [];
  for (let row = 0; row < count; row++) for (let column = 0; column < count; column++) {
    if (qr.isDark(row, column)) cells.push(`M${column + 4} ${row + 4}h1v1h-1z`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${count + 8} ${count + 8}" shape-rendering="crispEdges"><path fill="white" d="M0 0h${count + 8}v${count + 8}H0z"/><path fill="black" d="${cells.join("")}"/></svg>`;
  return { svg, origin, pairingUrl, expiresAt };
}
