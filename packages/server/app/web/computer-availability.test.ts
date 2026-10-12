import { afterEach, describe, expect, it, vi } from "vitest";
import { probeComputerAvailability } from "./computer-availability";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("computer availability", () => {
  it("accepts a public opaque response without sending credentials", async () => {
    const request = vi.fn().mockResolvedValue({ type: "opaque", ok: false });
    vi.stubGlobal("fetch", request);
    expect(await probeComputerAvailability("http://computer-b:3000")).toBe("online");
    const [url, options] = request.mock.calls[0];
    expect(url.origin).toBe("http://computer-b:3000");
    expect(url.pathname).toBe("/pwa/icon-192.png");
    expect(url.searchParams.has("online")).toBe(true);
    expect(options).toMatchObject({ credentials: "omit", cache: "no-store", mode: "no-cors", referrerPolicy: "no-referrer" });
  });
  it("reports connection failures without failing the computer menu", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    expect(await probeComputerAvailability("http://computer-b:3000")).toBe("offline");
  });
  it("does not start a probe after the menu has closed", async () => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    const controller = new AbortController();
    controller.abort();
    expect(await probeComputerAvailability("http://computer-b:3000", controller.signal)).toBe("offline");
    expect(request).not.toHaveBeenCalled();
  });
  it("aborts an unresponsive computer after four seconds", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    })));
    const result = probeComputerAvailability("http://computer-b:3000");
    await vi.advanceTimersByTimeAsync(4000);
    expect(await result).toBe("offline");
  });
});
