import { createRequire } from "node:module";
import jsQR from "jsqr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPairingScanner, decodePairingImage } from "../public/pwa/pairing-scan.js";

afterEach(() => vi.unstubAllGlobals());

function environment(secure = true) {
  const events = new Map<string, () => void>();
  vi.stubGlobal("window", { isSecureContext: secure, jsQR: vi.fn(), addEventListener: (type: string, listener: () => void) => events.set(type, listener), removeEventListener: vi.fn() });
  vi.stubGlobal("document", { hidden: false, addEventListener: (type: string, listener: () => void) => events.set(type, listener), removeEventListener: vi.fn(), createElement: () => ({ getContext: () => ({}) }) });
  return events;
}

describe("shared browser pairing scanner", () => {
  it("offers the link fallback on HTTP without requesting the camera", async () => {
    environment(false);
    const getUserMedia = vi.fn(); vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const error = vi.fn(), video = { srcObject: null };
    const scanner = createPairingScanner(video, vi.fn(), error);
    await scanner.start();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("HTTPS"));
    expect(getUserMedia).not.toHaveBeenCalled(); scanner.dispose();
  });

  it("releases a camera that arrives after the user cancels or closes the dialog", async () => {
    environment();
    let deliver!: (stream: unknown) => void;
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: () => new Promise(resolve => { deliver = resolve; }) } });
    const stop = vi.fn(), play = vi.fn(), video = { srcObject: null, play };
    const scanner = createPairingScanner(video, vi.fn(), vi.fn());
    const starting = scanner.start();
    await Promise.resolve(); scanner.dispose();
    deliver({ getTracks: () => [{ stop }] }); await starting;
    expect(stop).toHaveBeenCalledOnce(); expect(play).not.toHaveBeenCalled(); expect(video.srcObject).toBeNull();
  });

  it("stops the live camera when the page is hidden and removes listeners on disposal", async () => {
    const events = environment();
    const stop = vi.fn(), stream = { getTracks: () => [{ stop }] };
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => stream } });
    const video = { srcObject: null, play: async () => {}, videoWidth: 0 };
    const scanner = createPairingScanner(video, vi.fn(), vi.fn());
    await scanner.start();
    expect(video.srcObject).toBe(stream);
    Object.assign(document, { hidden: true }); events.get("visibilitychange")!();
    expect(stop).toHaveBeenCalledOnce(); expect(video.srcObject).toBeNull();
    scanner.dispose();
    expect(window.removeEventListener).toHaveBeenCalledWith("pagehide", expect.any(Function));
    expect(document.removeEventListener).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
  });

  it("decodes a camera photo on HTTP and always releases the image URL", async () => {
    environment(false);
    const raw = "https://computer.example/pair#pair=" + "g".repeat(43);
    Object.assign(window, { jsQR: vi.fn(() => ({ data: raw })) });
    const revoke = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: () => "blob:photo", revokeObjectURL: revoke });
    vi.stubGlobal("Image", class {
      naturalWidth = 800; naturalHeight = 600; onload?: () => void;
      set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    });
    Object.assign(document, { createElement: () => ({ getContext: () => ({ drawImage: vi.fn(), getImageData: () => ({ data: new Uint8ClampedArray(16), width: 2, height: 2 }) }) }) });
    expect(await decodePairingImage(new File(["photo"], "camera.jpg", { type: "image/jpeg" }))).toBe(raw);
    expect(revoke).toHaveBeenCalledWith("blob:photo");
    Object.assign(window, { jsQR: vi.fn(() => null) });
    await expect(decodePairingImage(new File(["photo"], "camera.jpg", { type: "image/jpeg" }))).rejects.toThrow("没有识别到二维码");
    expect(revoke).toHaveBeenCalledTimes(2);
  });

  it("decodes a small real QR in a high-resolution photo when the resized frame loses it", async () => {
    environment(false);
    const require = createRequire(new URL("../../cli/package.json", import.meta.url));
    const QRCode = require("qrcode-terminal/vendor/QRCode");
    const raw = "https://test-computer.connect.example.org/pair#pair=" + "g".repeat(43);
    const qr = new QRCode(-1, 1);
    qr.addData(raw);
    qr.make();
    const decode = vi.fn(jsQR);
    Object.assign(window, { jsQR: decode });
    vi.stubGlobal("URL", { createObjectURL: () => "blob:photo", revokeObjectURL: vi.fn() });
    vi.stubGlobal("Image", class {
      naturalWidth = 4032;
      naturalHeight = 3024;
      onload?: () => void;
      set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    });
    const cells = qr.getModuleCount(), moduleSize = 3;
    const canvas = { width: 0, height: 0, getContext: () => context };
    let crop = { x: 0, y: 0, width: 0, height: 0 };
    const context = {
      drawImage(_image: unknown, x: number, y: number, width: number, height: number) {
        crop = { x, y, width, height };
      },
      getImageData() {
        const { width, height } = canvas;
        const data = new Uint8ClampedArray(width * height * 4).fill(255);
        for (let y = 0; y < height; y++) {
          const row = Math.floor((crop.y + (y + 0.5) * crop.height / height - 1450) / moduleSize);
          if (row < 0 || row >= cells) continue;
          for (let x = 0; x < width; x++) {
            const column = Math.floor((crop.x + (x + 0.5) * crop.width / width - 1950) / moduleSize);
            if (column < 0 || column >= cells || !qr.isDark(row, column)) continue;
            const index = (y * width + x) * 4;
            data[index] = data[index + 1] = data[index + 2] = 0;
          }
        }
        return { data, width, height };
      },
    };
    Object.assign(document, { createElement: () => canvas });
    expect(await decodePairingImage(new File(["photo"], "camera.jpg", { type: "image/jpeg" }))).toBe(raw);
    expect(decode.mock.results[0].value).toBeNull();
  });

  it("rejects non-image and oversized photos before loading them", async () => {
    await expect(decodePairingImage({ type: "text/plain", size: 4 })).rejects.toThrow("请选择二维码照片");
    await expect(decodePairingImage({ type: "image/jpeg", size: 21 * 1024 * 1024 })).rejects.toThrow("照片过大");
  });
});
