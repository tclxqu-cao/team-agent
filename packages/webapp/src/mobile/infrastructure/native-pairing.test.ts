import { afterEach, describe, expect, it, vi } from "vitest";
import { NativePairingClient } from "./native-pairing";
import { parsePairingQr } from "../domain/pairing-qr";

const qr = JSON.stringify({ type: "agentroam-pair", version: 1, server: "https://computer.example", grant: "g".repeat(43) });
const storage = () => ({ get: vi.fn(async () => null as string | null), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) });
afterEach(() => { vi.useRealTimers(); });

describe("App QR pairing", () => {
  it("rejects ordinary URLs, short codes, URL credentials and unsupported QR versions", () => {
    for (const raw of ["https://computer.example/web", "12345678", qr.replace('"version":1', '"version":2'), qr.replace("computer.example", "user:secret@computer.example")]) expect(() => parsePairingQr(raw)).toThrow();
    expect(parsePairingQr(qr).endpoint.url).toBe("https://computer.example");
    expect(parsePairingQr(`https://computer.example/pair#pair=${"g".repeat(43)}`).grant).toBe("g".repeat(43));
  });
  it("stores the credential securely, scopes requests to its server and removes it on revocation", async () => {
    const store = storage(); const revoked = vi.fn();
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ token: "t".repeat(43) })).mockResolvedValueOnce(Response.json({ ok: true })).mockResolvedValueOnce(Response.json({ ok: true })).mockResolvedValueOnce(new Response(null, { status: 423 }));
    const client = new NativePairingClient(store, fetcher, revoked);
    await client.pair(qr);
    expect(store.set).toHaveBeenCalledWith("https://computer.example", "t".repeat(43));
    await client.fetch("https://computer.example/api/settings");
    expect(new Headers(fetcher.mock.calls[1][1].headers).get("authorization")).toBe(`Bearer ${"t".repeat(43)}`);
    expect(fetcher.mock.calls[1][1].redirect).toBe("error");
    await client.fetch("https://another.example/api/settings");
    expect(new Headers(fetcher.mock.calls[2][1].headers).has("authorization")).toBe(false);
    await client.fetch("https://computer.example/api/settings");
    expect(store.remove).toHaveBeenCalledWith("https://computer.example"); expect(revoked).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][0]).not.toContain("g".repeat(43));
  });
  it("does not persist or navigate on an expired QR", async () => {
    const store = storage(); const client = new NativePairingClient(store, vi.fn(async () => new Response(null, { status: 410 })));
    await expect(client.pair(qr)).rejects.toThrow(/已过期/); expect(store.set).not.toHaveBeenCalled();
  });
  it("allows a slow connection beyond ten seconds and clears its deadline after success", async () => {
    vi.useFakeTimers();
    const store = storage();
    let signal: AbortSignal;
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      signal = init!.signal!;
      await new Promise(resolve => setTimeout(resolve, 15_000));
      return Response.json({ token: "t".repeat(43) });
    });
    const pending = new NativePairingClient(store, fetcher).pair(qr);
    await vi.advanceTimersByTimeAsync(15_000);
    await pending;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(signal!.aborted).toBe(false);
    expect(store.set).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([false, true])("explains LAN timeouts without retrying or saving a credential (body pending: %s)", async bodyPending => {
    vi.useFakeTimers();
    const store = storage();
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      const stalled = () => new Promise<never>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
      });
      if (!bodyPending) return stalled();
      return { ok: true, json: stalled } as unknown as Response;
    });
    const pending = new NativePairingClient(store, fetcher).pair(qr.replace("https://computer.example", "http://192.168.1.10:3000"));
    const rejected = expect(pending).rejects.toThrow(/连接电脑超时（http:\/\/192\.168\.1\.10:3000）。.*同一网络.*防火墙.*刷新二维码/);
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(fetcher).toHaveBeenCalledOnce();
    expect(store.set).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([new DOMException("signal timed out", "TimeoutError"), new TypeError("Failed to fetch")])("explains remote network failures without exposing the grant", async cause => {
    const store = storage();
    const client = new NativePairingClient(store, vi.fn().mockRejectedValue(cause));
    await expect(client.pair(qr)).rejects.toThrow(/电脑.*https:\/\/computer\.example.*远程连接.*刷新二维码/);
    expect(store.set).not.toHaveBeenCalled();
  });
  it("clears an idle App session after computer lock without needing a business request", async () => {
    const store = storage(); store.get.mockResolvedValue("t".repeat(43)); const revoked = vi.fn();
    const client = new NativePairingClient(store, vi.fn(async () => Response.json({ locked: true, authenticated: false })), revoked);
    await client.resume(parsePairingQr(qr).endpoint); await client.checkAuthorization();
    expect(store.remove).toHaveBeenCalledWith("https://computer.example"); expect(revoked).toHaveBeenCalledOnce();
  });
});
