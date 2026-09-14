import { Capacitor } from "@capacitor/core";
import { CapacitorBarcodeScanner, CapacitorBarcodeScannerTypeHint } from "@capacitor/barcode-scanner";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";
import { parsePairingQr } from "../domain/pairing-qr";
import type { ServerEndpoint } from "../domain/server-endpoint";

export interface DeviceCredentialStorage {
  get(origin: string): Promise<string | null>;
  set(origin: string, token: string): Promise<void>;
  remove(origin: string): Promise<void>;
}

export class NativeCredentialStorage implements DeviceCredentialStorage {
  private ready() {
    if (!Capacitor.isNativePlatform()) throw new Error("请在 AgentRoam App 中扫码连接。");
  }
  async get(origin: string) {
    this.ready();
    try { return (await SecureStoragePlugin.get({ key: `agentroam-device:${origin}` })).value; }
    catch (error) { if (String(error).includes("does not exist")) return null; throw new Error("无法读取设备凭证，请重试。"); }
  }
  async set(origin: string, token: string) { this.ready(); await SecureStoragePlugin.set({ key: `agentroam-device:${origin}`, value: token }); }
  async remove(origin: string) {
    this.ready();
    try { await SecureStoragePlugin.remove({ key: `agentroam-device:${origin}` }); }
    catch (error) { if (!String(error).includes("does not exist")) throw error; }
  }
}

export async function scanPairingQr(): Promise<string | null> {
  if (!Capacitor.isNativePlatform()) throw new Error("请在 AgentRoam App 中使用相机扫码。");
  try {
    const result = await CapacitorBarcodeScanner.scanBarcode({ hint: CapacitorBarcodeScannerTypeHint.QR_CODE, scanInstructions: "扫描电脑上的 AgentRoam 授权二维码", cameraDirection: 1 });
    return result.ScanResult || null;
  } catch (error) {
    if (/cancel/i.test(String(error))) return null;
    throw new Error("无法打开相机，请在系统设置中允许 AgentRoam 使用相机后重试。");
  }
}

/** Explicit bearer transport avoids third-party cookie restrictions in native WebViews. */
export class NativePairingClient {
  private session: { origin: string; token: string } | null = null;
  constructor(private storage: DeviceCredentialStorage, private transport: typeof fetch = (...args) => fetch(...args), private onRevoked: () => void = () => window.dispatchEvent(new CustomEvent("webapp:unauthorized"))) {}

  async resume(endpoint: ServerEndpoint): Promise<void> {
    const token = await this.storage.get(endpoint.url);
    this.session = token ? { origin: endpoint.url, token } : null;
  }

  async pair(raw: string): Promise<ServerEndpoint> {
    const { endpoint, grant } = parsePairingQr(raw);
    const response = await this.transport(endpoint.api("/api/pairing/qr-exchange"), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grant, name: "我的 App" }),
      credentials: "omit", redirect: "error", signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(response.status === 423 ? "电脑已锁定远程访问，请先在电脑上解锁。" : response.status === 410 ? "二维码已使用或已过期，请在电脑上重新生成。" : "扫码连接失败，请检查服务器地址和网络后重试。");
    const value = await response.json();
    if (typeof value.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.token)) throw new Error("服务器返回了无效的设备凭证。");
    try { await this.storage.set(endpoint.url, value.token); }
    catch {
      // A credential that cannot be saved must not silently leave an enrolled App.
      await this.transport(endpoint.api("/api/pairing/logout"), { method: "POST", headers: { authorization: `Bearer ${value.token}` }, credentials: "omit", redirect: "error", signal: AbortSignal.timeout(5000) }).catch(() => {});
      throw new Error("无法安全保存设备凭证，请在电脑上重新生成二维码后重试。");
    }
    this.session = { origin: endpoint.url, token: value.token };
    return endpoint;
  }

  async checkAuthorization(): Promise<void> {
    const session = this.session;
    if (!session) return;
    const response = await this.fetch(`${session.origin}/api/web-auth/status`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return;
    const status = await response.json();
    if (this.session === session && (status.locked || status.authenticated === false)) {
      this.session = null;
      try { await this.storage.remove(session.origin); } finally { this.onRevoked(); }
    }
  }

  fetch: typeof fetch = async (input, init = {}) => {
    const session = this.session;
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    if (session && url.origin === session.origin) headers.set("authorization", `Bearer ${session.token}`);
    const response = await this.transport(input, { ...init, headers, credentials: "omit", redirect: "error" });
    if (session && this.session === session && url.origin === session.origin && (response.status === 401 || response.status === 423)) {
      this.session = null;
      try { await this.storage.remove(session.origin); } finally { this.onRevoked(); }
    }
    return response;
  };
}
