import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import {
  ChromeReauthController, GOOGLE_REAUTH_TEMP_PREFIX, cleanupAbandonedReauthProfiles,
  connectBrowserCdp, parseDevToolsActivePort, waitForDevToolsPortFile,
  type CdpConnection,
} from "./chrome-reauth-session";
import type { ElectronCookieDetails } from "./cookie-migration";

class FakeChild extends EventEmitter {
  killed = false;
  exitCode: number | null = null;
  signalCode: string | null = null;
  kill(): boolean {
    this.killed = true;
    queueMicrotask(() => { this.signalCode = "SIGTERM"; this.emit("exit", null, "SIGTERM"); });
    return true;
  }
}

const testCookie = { name: "SESSION", value: "test-only", domain: ".google.com", path: "/", expires: -1, httpOnly: true, secure: true };
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function makeEnv(options: { timeoutMs?: number; hang?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "hub-reauth-test-"));
  const chromePath = join(root, "fake-chrome");
  writeFileSync(chromePath, "");
  const child = new FakeChild();
  const listeners: Array<Parameters<CdpConnection["onEvent"]>[0]> = [];
  const origins = new Map<string, string>();
  let cookies: unknown[] = [testCookie];
  const send = vi.fn(async (method: string, _params?: Record<string, unknown>, sessionId?: string): Promise<unknown> => {
    if (method === "Runtime.evaluate") return { result: { value: origins.get(sessionId ?? "") } };
    if (method === "Storage.getCookies") return { cookies };
    return {};
  });
  const close = vi.fn();
  const connection: CdpConnection = { send, close, onEvent: (listener) => listeners.push(listener) };
  const spawnProcess = vi.fn(() => child);
  const connectCdp = vi.fn(async () => connection);
  const controller = new ChromeReauthController({
    chromePath, tempRoot: join(root, "reauth"), timeoutMs: options.timeoutMs ?? 5000,
    spawnProcess: spawnProcess as never, connectCdp,
    waitForPortFile: options.hang ? () => new Promise(() => {})
      : async () => ({ port: 7777, browserPath: "/devtools/browser/real-browser-id" }),
  });
  const onCookies = vi.fn(async (_details: ElectronCookieDetails[]) => {});
  const request = { siteId: "gemini", homeUrl: "https://gemini.google.com/app", successOrigin: "https://gemini.google.com", onCookies };
  const emit = (method: string, params: Record<string, unknown>, sessionId?: string) => {
    for (const listener of listeners) listener({ method, params, sessionId });
  };
  const attach = (id: string, origin = request.successOrigin, type = "page") => {
    origins.set(id, origin);
    // Chrome browser-level attachedToTarget has no outer sessionId.
    emit("Target.attachedToTarget", { sessionId: id, targetInfo: { type, targetId: `target-${id}` } });
  };
  const ready = () => vi.waitFor(() => expect(send).toHaveBeenCalledWith("Target.setAutoAttach", expect.any(Object)));
  cleanups.push(() => { controller.cancel(); rmSync(root, { recursive: true, force: true }); });
  return { root, child, controller, request, send, close, spawnProcess, connectCdp, onCookies, attach, emit, origins, ready, setCookies: (value: unknown[]) => { cookies = value; } };
}

describe("Chrome DevTools transport", () => {
  it("requires both complete endpoint lines and rejects malformed ports or remote paths", () => {
    expect(parseDevToolsActivePort("9222\r\n/devtools/browser/abc-123\r\n")).toEqual({ port: 9222, browserPath: "/devtools/browser/abc-123" });
    for (const input of ["9222", "9222junk\n/devtools/browser/abc", "0\n/devtools/browser/abc", "65536\n/devtools/browser/abc", "9222\n/devtools/browser", "9222\n//evil.test/path", ""]) {
      expect(parseDevToolsActivePort(input)).toBeNull();
    }
  });

  it("waits for the second line when Chrome is still writing the endpoint file", async () => {
    const env = makeEnv();
    const file = join(env.root, "DevToolsActivePort");
    writeFileSync(file, "12345\n");
    const result = waitForDevToolsPortFile(file, 1000);
    writeFileSync(file, "12345\n/devtools/browser/abc");
    await expect(result).resolves.toEqual({ port: 12345, browserPath: "/devtools/browser/abc" });
  });

  it("connects to the generated WebSocket path and preserves real CDP event envelopes", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0, path: "/devtools/browser/generated-id" });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    server.on("connection", (socket) => socket.on("message", (raw) => {
      const request = JSON.parse(raw.toString());
      if (request.method === "Target.setAutoAttach") {
        socket.send(JSON.stringify({ method: "Target.attachedToTarget", params: { sessionId: "page-1", targetInfo: { type: "page" } } }));
        socket.send(JSON.stringify({ id: request.id, result: {} }));
      } else if (request.method === "Runtime.evaluate") {
        socket.send(JSON.stringify({ id: request.id, sessionId: request.sessionId, result: { result: { value: "https://gemini.google.com" } } }));
      } else socket.close();
    }));
    const address = server.address() as { port: number };
    const client = await connectBrowserCdp({ port: address.port, browserPath: "/devtools/browser/generated-id" });
    try {
      const events: unknown[] = [];
      client.onEvent((event) => events.push(event));
      await client.send("Target.setAutoAttach", { autoAttach: true });
      expect(events).toEqual([{ method: "Target.attachedToTarget", params: { sessionId: "page-1", targetInfo: { type: "page" } }, sessionId: undefined }]);
      await expect(client.send("Runtime.evaluate", { expression: "location.origin" }, "page-1")).resolves.toEqual({ result: { value: "https://gemini.google.com" } });
      await expect(client.send("Disconnected.command")).rejects.toThrow("cdp-error");
    } finally {
      client.close();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("ChromeReauthController", () => {
  it("keeps the homepage open until explicit sync and then transfers only provider cookies", async () => {
    const env = makeEnv();
    env.setCookies([testCookie, { ...testCookie, domain: ".evil.test" }, { ...testCookie, partitionKey: { topLevelSite: "https://google.com" } }]);
    const pending = env.controller.start(env.request);
    await env.ready();
    env.attach("provider");
    env.emit("Page.frameNavigated", { frame: { url: env.request.homeUrl } }, "provider");
    expect(env.onCookies).not.toHaveBeenCalled();
    expect(env.child.killed).toBe(false);
    expect(env.connectCdp).toHaveBeenCalledWith({ port: 7777, browserPath: "/devtools/browser/real-browser-id" });
    expect(await env.controller.attemptSyncNow("gemini")).toEqual({ status: "synchronized" });
    expect(await pending).toEqual({ status: "synchronized" });
    expect(env.onCookies).toHaveBeenCalledTimes(1);
    expect(env.onCookies.mock.calls[0][0]).toHaveLength(1);
    expect(env.controller.isRunning()).toBe(false);
    expect(env.close).toHaveBeenCalled();
    expect(env.child.killed).toBe(true);
    const args = env.spawnProcess.mock.calls[0] as unknown as [string, string[]];
    expect(args[1]).toContain("--remote-debugging-port=0");
  });

  it("does not sync or close when the page is still on Google Accounts", async () => {
    const env = makeEnv();
    const pending = env.controller.start(env.request);
    await env.ready();
    env.attach("login", "https://accounts.google.com");
    expect(await env.controller.attemptSyncNow("gemini")).toEqual({ status: "waiting", reason: "login-callback-origin-mismatch" });
    expect(env.onCookies).not.toHaveBeenCalled();
    expect(env.controller.isRunning()).toBe(true);
    env.origins.set("login", env.request.successOrigin);
    expect((await env.controller.attemptSyncNow("gemini")).status).toBe("synchronized");
    await pending;
  });

  it("ignores iframe targets and detached pages; a second provider tab may complete login", async () => {
    const env = makeEnv();
    const pending = env.controller.start(env.request);
    await env.ready();
    env.attach("iframe", env.request.successOrigin, "iframe");
    env.attach("closed");
    env.emit("Target.detachedFromTarget", { sessionId: "closed" });
    expect((await env.controller.attemptSyncNow("gemini")).status).toBe("waiting");
    env.attach("accounts", "https://accounts.google.com");
    env.attach("provider");
    expect((await env.controller.attemptSyncNow("gemini")).status).toBe("synchronized");
    await pending;
    expect(env.send.mock.calls.some((call) => call[2] === "iframe" || call[2] === "closed")).toBe(false);
  });

  it("does not infer a session from an empty cookie jar", async () => {
    const env = makeEnv();
    env.setCookies([]);
    void env.controller.start(env.request);
    await env.ready();
    env.attach("provider");
    expect(await env.controller.attemptSyncNow("gemini")).toEqual({ status: "waiting", reason: "login-session-not-found" });
    expect(env.onCookies).not.toHaveBeenCalled();
    expect(env.child.killed).toBe(false);
  });

  it("rejects stale location observations before writing", async () => {
    const env = makeEnv();
    void env.controller.start(env.request);
    await env.ready();
    env.attach("provider");
    env.send.mockImplementation(async (method) => method === "Storage.getCookies"
      ? (env.origins.set("provider", "https://accounts.google.com"), { cookies: [testCookie] })
      : { result: { value: env.origins.get("provider") } });
    expect((await env.controller.attemptSyncNow("gemini")).status).toBe("waiting");
    expect(env.onCookies).not.toHaveBeenCalled();
  });

  it("does not synchronize on a second start or from a different site's sync button", async () => {
    const env = makeEnv();
    const pending = env.controller.start(env.request);
    expect(await env.controller.start({ ...env.request, siteId: "grok" })).toEqual({ status: "waiting", reason: "chrome-login-in-progress" });
    await env.ready();
    env.attach("provider");
    expect((await env.controller.start(env.request)).status).toBe("waiting");
    expect((await env.controller.attemptSyncNow("grok")).status).toBe("waiting");
    expect(env.onCookies).not.toHaveBeenCalled();
    const results = await Promise.all([env.controller.attemptSyncNow("gemini"), env.controller.attemptSyncNow("gemini")]);
    expect(results.map((result) => result.status)).toEqual(["synchronized", "synchronized"]);
    expect(env.onCookies).toHaveBeenCalledTimes(1);
    await pending;
  });

  it("does not write if canceled while reading cookies", async () => {
    const env = makeEnv();
    void env.controller.start(env.request);
    await env.ready();
    env.attach("provider");
    env.send.mockImplementation(async (method) => {
      if (method === "Storage.getCookies") { env.controller.cancel(); return { cookies: [testCookie] }; }
      return { result: { value: env.request.successOrigin } };
    });
    expect((await env.controller.attemptSyncNow("gemini")).status).toBe("canceled");
    expect(env.onCookies).not.toHaveBeenCalled();
  });

  it("retains Chrome for retry after a cookie install failure", async () => {
    const env = makeEnv();
    const pending = env.controller.start(env.request);
    await env.ready();
    env.attach("provider");
    env.onCookies.mockRejectedValueOnce(new Error("write failed"));
    expect(await env.controller.attemptSyncNow("gemini")).toEqual({ status: "waiting", reason: "cookie-sync-failed" });
    expect(env.child.killed).toBe(false);
    expect((await env.controller.attemptSyncNow("gemini")).status).toBe("synchronized");
    await pending;
  });

  it.each(["chatgpt", "grok"])("does not transfer Google account cookies into %s", async (siteId) => {
    const env = makeEnv();
    const origin = `https://${siteId}.com`;
    env.setCookies([testCookie, { ...testCookie, domain: `.${siteId}.com` }]);
    const pending = env.controller.start({ ...env.request, siteId, homeUrl: `${origin}/`, successOrigin: origin });
    await env.ready();
    env.attach("provider", origin);
    expect((await env.controller.attemptSyncNow(siteId)).status).toBe("synchronized");
    expect(env.onCookies.mock.calls[0][0].map((cookie) => cookie.domain)).toEqual([`.${siteId}.com`]);
    await pending;
  });

  it("returns waiting before Chrome is ready and times out without writes", async () => {
    const env = makeEnv({ hang: true, timeoutMs: 80 });
    const pending = env.controller.start(env.request);
    expect((await env.controller.attemptSyncNow("gemini")).status).toBe("waiting");
    expect(await pending).toEqual({ status: "timeout", reason: "chrome-login-timeout" });
    expect(env.onCookies).not.toHaveBeenCalled();
  });

  it("settles cancellation on child exit and cleans up after exit", async () => {
    const env = makeEnv();
    const pending = env.controller.start(env.request);
    await env.ready();
    env.child.exitCode = 0;
    env.child.emit("exit", 0);
    expect((await pending).status).toBe("canceled");
    expect(env.onCookies).not.toHaveBeenCalled();
  });

  it("reports unavailable without attempting spawn if Chrome is missing", async () => {
    const env = makeEnv();
    rmSync(join(env.root, "fake-chrome"));
    expect((await env.controller.start(env.request)).status).toBe("unavailable");
    expect(env.spawnProcess).not.toHaveBeenCalled();
  });
});

describe("cleanupAbandonedReauthProfiles", () => {
  it("only removes temporary reauth profiles", async () => {
    const env = makeEnv();
    mkdirSync(join(env.root, `${GOOGLE_REAUTH_TEMP_PREFIX}orphan`));
    mkdirSync(join(env.root, "unrelated"));
    await cleanupAbandonedReauthProfiles(env.root);
    expect(existsSync(join(env.root, `${GOOGLE_REAUTH_TEMP_PREFIX}orphan`))).toBe(false);
    expect(existsSync(join(env.root, "unrelated"))).toBe(true);
  });
});
