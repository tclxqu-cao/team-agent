import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TunnelStatus } from "../../../server/lib/tunnel-control.mjs";
import { PairingRoutePicker, TunnelConnectionControl } from "./TunnelConnectionControl";
import { pairingRouteOptions } from "../lib/pairing-route-options";

const lan: TunnelStatus = { phase: "idle", mode: "lan", provider: "lan", accessUrl: "http://192.168.1.10:3000/web" };
const render = (status: TunnelStatus) => renderToStaticMarkup(<TunnelConnectionControl connection={{ status, requesting: false, failure: "", connect: vi.fn() }} />);
describe("shared desktop public connection controls", () => {
  it("shows all five methods before the first invitation and route response", () => {
    const html = renderToStaticMarkup(<PairingRoutePicker api={{ pairingRoutes: vi.fn() }} busy value="" onChange={vi.fn()} />);
    expect(html).toContain("扫码连接方式");
    for (const label of ["自建 VPN", "局域网", "Tailscale", "本机网络 IP", "Cloudflare"]) expect(html).toContain(label);
    expect(html.match(/<option\b[^>]*\bdisabled/g)).toHaveLength(5);
  });
  it("offers VPN, LAN, Tailscale and raw NIC addresses using the backend's original route IDs", () => {
    const options = pairingRouteOptions([
      { id: "10.0.0.2", kind: "lan", address: "10.0.0.2", interfaceName: "wg0" },
      { id: "192.168.1.2", kind: "lan", address: "192.168.1.2", interfaceName: "en0" },
      { id: "100.64.0.2", kind: "tailscale", address: "100.64.0.2", interfaceName: "utun8" },
      { id: "headscale", kind: "headscale", address: "desktop.mesh" },
      { id: "cloudflare", kind: "cloudflare" }, { id: "self-hosted", kind: "self-hosted" },
    ], "后台未提供");
    const ids = (prefix: string) => options.filter(o => o.label.startsWith(prefix)).map(o => o.route?.id);
    expect(ids("自建 VPN")).toEqual(["10.0.0.2", "headscale"]);
    expect(ids("局域网")).toEqual(["192.168.1.2"]);
    expect(ids("Tailscale")).toEqual(["100.64.0.2"]);
    expect(ids("本机网络 IP")).toEqual(["10.0.0.2", "192.168.1.2", "100.64.0.2"]);
    expect(ids("Cloudflare")).toEqual(["cloudflare"]);
    expect(ids("自建 HTTPS")).toEqual(["self-hosted"]);
    expect(new Set(options.map(o => o.key)).size).toBe(options.length);
  });
  it("explains the LAN requirement and offers the enable action", () => {
    const html = render(lan);
    expect(html).toContain("仅局域网"); expect(html).toContain("开启公网连接");
    expect(html).toContain("同一 Wi-Fi"); expect(html).not.toContain("disabled");
  });
  it("disables the action while checking the public address", () => {
    const html = render({ ...lan, phase: "connecting", stage: "checking" });
    expect(html).toContain("正在连接公网"); expect(html).toContain("正在检查公网地址"); expect(html).toContain('disabled=""');
  });
  it("reports public readiness without offering a redundant reconnect", () => {
    const html = render({ phase: "ready", mode: "public", provider: "cloudflare", accessUrl: "https://working.example/web" });
    expect(html).toContain("公网已连接"); expect(html).not.toContain("<button");
  });
  it("shows a retry action and keeps the LAN explanation after failure", () => {
    const html = render({ ...lan, phase: "error", error: "公网地址可达性检查未通过" });
    expect(html).toContain("重试连接"); expect(html).toContain("可达性检查未通过"); expect(html).toContain("同一 Wi-Fi");
  });
  it("requires an upgrade for old backends and disables the action", () => {
    const html = render({ phase: "unsupported", mode: "local", provider: "lan", error: "请升级后台服务" });
    expect(html).toContain("请升级后台服务"); expect(html).toContain('disabled=""');
  });
  it("distinguishes local-only access from LAN access", () => {
    const html = render({ ...lan, mode: "local", accessUrl: "http://127.0.0.1:3000/web" });
    expect(html).toContain("仅本机"); expect(html).toContain("仅限这台电脑访问"); expect(html).not.toContain("同一 Wi-Fi");
  });
});
