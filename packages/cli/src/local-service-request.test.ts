import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { localServiceRequest } from "./local-service-request.js";
import { pairingAdmin } from "./device-pairing.js";

async function fixture() {
  const registry = await mkdtemp(join(tmpdir(), "agentroam-local-client-"));
  const descriptor = { protocol: 1, instanceId: "instance", pid: 123, url: "http://127.0.0.1:4317", dataDir: registry, token: "a".repeat(64) };
  return { registry, descriptor, write: (value = descriptor) => writeFile(join(registry, "service.json"), JSON.stringify(value)),
    close: () => rm(registry, { recursive: true, force: true }) };
}

describe("private local service requests", () => {
  it.each(["https://public.example", "http://public.example:4317", "http://127.0.0.1:4317/path", "http://user:password@127.0.0.1:4317", "http://127.0.0.1:4317?redirect=1"])("never sends the token to %s", async (url) => {
    const f = await fixture();
    try {
      await f.write({ ...f.descriptor, url });
      const request = vi.fn();
      await expect(localServiceRequest(f.registry, "/api/remote-authorization", { registry: f.registry, request })).rejects.toThrow("未找到");
      expect(request).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it("rejects a stale identity before issuing an authorization operation", async () => {
    const f = await fixture();
    try {
      await f.write();
      const request = vi.fn(async () => Response.json({ ...f.descriptor, instanceId: "replaced" }));
      await expect(localServiceRequest(f.registry, "/api/remote-authorization", { registry: f.registry, request, method: "POST", body: { action: "enable" } })).rejects.toThrow("未找到");
      expect(request).toHaveBeenCalledOnce();
      expect(String(request.mock.calls[0]![0])).toContain("/api/desktop/identity");
    } finally { await f.close(); }
  });

  it("uses an identity-checked loopback request with redirects disabled", async () => {
    const f = await fixture();
    try {
      await f.write();
      const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(f.descriptor)).mockResolvedValueOnce(Response.json({ enabled: true }));
      expect(await localServiceRequest(f.registry, "/api/remote-authorization", { registry: f.registry, request, method: "POST", body: { action: "enable" } })).toEqual({ enabled: true });
      expect(request).toHaveBeenLastCalledWith(new URL("/api/remote-authorization", f.descriptor.url), expect.objectContaining({
        method: "POST", redirect: "error", body: '{"action":"enable"}',
        headers: expect.objectContaining({ "x-agentroam-desktop-token": f.descriptor.token }),
      }));
    } finally { await f.close(); }
  });

  it("surfaces the local service error detail without exposing a generic status only", async () => {
    const f = await fixture();
    try {
      await f.write();
      const request = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json(f.descriptor))
        .mockResolvedValueOnce(Response.json({ error: "另一实例正在更新远控组件，请稍后重试" }, { status: 400 }));
      await expect(localServiceRequest(f.registry, "/api/remote-authorization", {
        registry: f.registry, request, method: "POST", body: { action: "recheck" },
      })).rejects.toMatchObject({
        status: 400,
        detail: "另一实例正在更新远控组件，请稍后重试",
        message: "本机服务请求失败 (HTTP 400): 另一实例正在更新远控组件，请稍后重试",
      });
    } finally { await f.close(); }
  });

  it("retains pairing conflict errors through the shared client", async () => {
    const f = await fixture();
    try {
      await f.write();
      const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(f.descriptor)).mockResolvedValueOnce(new Response("", { status: 409 }));
      await expect(pairingAdmin(f.registry, "approve", {}, { registry: f.registry, request })).rejects.toThrow("Verification phrase does not match");
    } finally { await f.close(); }
  });

  it("preserves cancellation during identity lookup and never sends the authorization request", async () => {
    const f = await fixture();
    try {
      await f.write();
      const controller = new AbortController();
      const request = vi.fn<typeof fetch>(async (_url, options) => {
        controller.abort(new Error("skip authorization"));
        expect(options?.signal?.aborted).toBe(true);
        throw controller.signal.reason;
      });
      await expect(localServiceRequest(f.registry, "/api/remote-authorization", {
        registry: f.registry, request, signal: controller.signal, method: "POST", body: { action: "enable" },
      })).rejects.toThrow("skip authorization");
      expect(request).toHaveBeenCalledOnce();
    } finally { await f.close(); }
  });

  it("forwards cancellation to the authorization HTTP request", async () => {
    const f = await fixture();
    try {
      await f.write();
      const controller = new AbortController();
      let started!: () => void;
      const startedRequest = new Promise<void>((resolve) => { started = resolve; });
      const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(f.descriptor))
        .mockImplementationOnce(async (_url, options) => {
          started();
          return new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(options.signal!.reason), { once: true }));
        });
      const pending = localServiceRequest(f.registry, "/api/remote-authorization", {
        registry: f.registry, request, signal: controller.signal, method: "POST", body: { action: "request-permission", permission: "screen" },
      });
      const cancelled = expect(pending).rejects.toThrow("skip authorization");
      await startedRequest;
      controller.abort(new Error("skip authorization"));
      await cancelled;
      expect(request).toHaveBeenCalledTimes(2);
    } finally { await f.close(); }
  });
});
