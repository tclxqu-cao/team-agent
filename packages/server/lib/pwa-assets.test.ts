import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createRequire } from "node:module";
import jsQR from "jsqr";
import { pairingQrPayload } from "../../cli/src/device-pairing";
import { parsePairingQr } from "../../webapp/src/mobile/domain/pairing-qr";
import { describe, expect, it, vi } from "vitest";

describe("PWA offline boundary", () => {
  it("decodes the CLI QR with the Safari-compatible decoder and preserves the one-time grant", () => {
    const require = createRequire(new URL("../../cli/package.json", import.meta.url));
    const QRCode = require("qrcode-terminal/vendor/QRCode");
    const grant = "g".repeat(43), payload = pairingQrPayload("https://computer.example/web", grant);
    const qr = new QRCode(-1, 1); qr.addData(payload); qr.make();
    const cells = qr.getModuleCount(), scale = 8, size = (cells + 8) * scale;
    const pixels = new Uint8ClampedArray(size * size * 4).fill(255);
    for (let y = 0; y < cells; y++) for (let x = 0; x < cells; x++) if (qr.isDark(y, x)) {
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
        const at = (((y + 4) * scale + dy) * size + (x + 4) * scale + dx) * 4;
        pixels[at] = pixels[at + 1] = pixels[at + 2] = 0;
      }
    }
    const decoded = jsQR(pixels, size, size);
    expect(decoded?.data).toBe(payload); expect(parsePairingQr(decoded!.data).grant).toBe(grant);
  });
  it("caches only the public offline page and never intercepts API operations", async () => {
    const listeners: Record<string, (event: any) => void> = {};
    const add = vi.fn(async (_request: Request) => {}); const match = vi.fn(async () => new Response("public offline page"));
    const transport = vi.fn(async (_request: Request) => { throw new Error("offline"); });
    class WorkerRequest extends Request {
      constructor(input: RequestInfo | URL, init?: RequestInit) { super(typeof input === "string" ? new URL(input, "https://computer.example").href : input, init); }
    }
    const script = readFileSync(new URL("../public/pwa/service-worker.js", import.meta.url), "utf8");
    runInNewContext(script, { URL, Request: WorkerRequest, Response, caches: { open: async () => ({ add }), match }, fetch: transport, self: { location: { origin: "https://computer.example" }, addEventListener: (type: string, fn: any) => { listeners[type] = fn; }, skipWaiting: async () => {} } });
    let install: Promise<unknown> | undefined;
    listeners.install({ waitUntil: (value: Promise<unknown>) => { install = value; } }); await install;
    expect(add).toHaveBeenCalledOnce(); expect(add.mock.calls[0][0].url).toBe("https://computer.example/pwa/offline.html");
    for (const request of [{ mode: "cors", method: "GET", url: "https://computer.example/api/settings" }, { mode: "cors", method: "POST", url: "https://computer.example/api/agent/run" }]) {
      const respondWith = vi.fn(); listeners.fetch({ request, respondWith }); expect(respondWith).not.toHaveBeenCalled();
    }
    const navigation = new Request("https://computer.example/web");
    Object.defineProperty(navigation, "mode", { value: "navigate" });
    let response: Promise<Response> | undefined;
    listeners.fetch({ request: navigation, respondWith: (value: Promise<Response>) => { response = value; } });
    expect(await (await response!).text()).toBe("public offline page");
    expect(transport.mock.calls[0][0].cache).toBe("no-store");
    expect(match).toHaveBeenCalledWith("/pwa/offline.html"); expect(add).toHaveBeenCalledOnce();
  });
});
