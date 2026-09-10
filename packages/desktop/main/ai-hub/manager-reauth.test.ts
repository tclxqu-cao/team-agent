import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  sessions: new Map<string, { cookies: { set: ReturnType<typeof vi.fn>; flushStore: ReturnType<typeof vi.fn> }; setPermissionRequestHandler: ReturnType<typeof vi.fn> }>(),
}));
vi.mock("node:module", () => ({
  createRequire: () => () => {
    const getSession = (key: string) => {
      if (!mock.sessions.has(key)) mock.sessions.set(key, {
        cookies: { set: vi.fn().mockResolvedValue(undefined), flushStore: vi.fn().mockResolvedValue(undefined) },
        setPermissionRequestHandler: vi.fn(),
      });
      return mock.sessions.get(key);
    };
    return {
      session: { fromPath: getSession },
      WebContentsView: class {
        webContents: EventEmitter & { session: unknown; setWindowOpenHandler: () => void; close: () => void };
        constructor({ webPreferences }: { webPreferences: { session?: unknown; partition?: string } }) {
          this.webContents = Object.assign(new EventEmitter(), {
            session: webPreferences.session ?? getSession(webPreferences.partition!),
            setWindowOpenHandler: () => {}, close: () => {},
          });
        }
        setBackgroundColor() {}
      },
    };
  },
}));
import { AIHubManager } from "./manager";
const roots: string[] = [];
afterEach(() => { mock.sessions.clear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function makeManager(profile: string | null = null) {
  const root = mkdtempSync(join(tmpdir(), "hub-manager-reauth-"));
  roots.push(root);
  const requestBrowserLogin = vi.fn();
  const manager = new AIHubManager({ configPath: join(root, "config.json"), getWindow: () => null,
    getImportedProfilePath: () => profile, requestBrowserLogin });
  return { manager, requestBrowserLogin };
}
const cookie = { url: "https://gemini.google.com/", name: "test", value: "test-only" };

describe("AI Hub reauth session routing", () => {
  it("starts managed login without importing browser history or a profile", () => {
    const { manager, requestBrowserLogin } = makeManager();
    expect(manager.requestExistingBrowserLogin("gemini")).toBe(true);
    expect(requestBrowserLogin).toHaveBeenCalledWith("gemini");
  });

  it("uses Chrome for the three supported sites and keeps DeepSeek on Electron", async () => {
    const root = mkdtempSync(join(tmpdir(), "hub-manager-chrome-"));
    roots.push(root);
    const request = vi.fn().mockResolvedValue({ submitted: true, messages: [] });
    const manager = new AIHubManager({ configPath: join(root, "config.json"), getWindow: () => null, chromeBridge: { request } as never });
    expect(manager.usesChrome("chatgpt")).toBe(true);
    expect(manager.usesChrome("gemini")).toBe(true);
    expect(manager.usesChrome("grok")).toBe(true);
    expect(manager.usesChrome("deepseek")).toBe(false);
    await manager.openSite("chatgpt");
    expect(mock.sessions.size).toBe(0);
    expect(await manager.broadcast("hello", ["chatgpt"])).toEqual([{ siteId: "chatgpt", ok: true }]);
    expect(request).toHaveBeenCalledWith("chatgpt", "send-message", { text: "hello", images: [] });
    const capture = await manager.captureConversations(["chatgpt"]);
    expect(capture).toEqual([{ siteId: "chatgpt", ok: true, strategy: "chatgpt", messages: [] }]);
    manager.reloadSite("chatgpt");
    expect(request).toHaveBeenCalledWith("chatgpt", "reload");
    manager.closeSite("chatgpt");
    expect(request).toHaveBeenCalledWith("chatgpt", "detach");
  });

  it("reports disconnected Chrome instead of sending to an unrelated Electron pane", async () => {
    const root = mkdtempSync(join(tmpdir(), "hub-manager-chrome-failed-"));
    roots.push(root);
    const request = vi.fn().mockRejectedValue(new Error("not connected"));
    const manager = new AIHubManager({ configPath: join(root, "config.json"), getWindow: () => null, chromeBridge: { request } as never });
    expect(await manager.broadcast("hello", ["gemini"])).toEqual([{ siteId: "gemini", ok: false, reason: "not connected" }]);
    expect(mock.sessions.size).toBe(0);
  });
  it("starts Chrome sends concurrently and keeps unconfirmed submission separate from success", async () => {
    const root = mkdtempSync(join(tmpdir(), "hub-manager-parallel-")); roots.push(root);
    let release!: (value: unknown) => void;
    const request = vi.fn((siteId: string) => siteId === "chatgpt" ? new Promise((resolve) => { release = resolve; }) : Promise.resolve({submitted:true}));
    const manager = new AIHubManager({configPath:join(root,"config.json"),getWindow:()=>null,chromeBridge:{request} as never});
    const pending = manager.broadcast("hello", ["chatgpt","gemini","grok"]);
    expect(request).toHaveBeenCalledTimes(3);
    release({submitted:false});
    const results = await pending;
    expect(results[0]).toMatchObject({siteId:"chatgpt",ok:false,reason:expect.stringContaining("尚未确认")});
    expect(results.slice(1)).toEqual([{siteId:"gemini",ok:true},{siteId:"grok",ok:true}]);
  });

});
