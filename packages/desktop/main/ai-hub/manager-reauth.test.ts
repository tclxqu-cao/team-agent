import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  sessions: new Map<string, { cookies: { set: ReturnType<typeof vi.fn>; flushStore: ReturnType<typeof vi.fn> }; setPermissionRequestHandler: ReturnType<typeof vi.fn> }>(),
  views: [] as Array<{ setVisible: ReturnType<typeof vi.fn>; setBounds: ReturnType<typeof vi.fn>; webPreferences: Record<string, unknown>; webContents: { debugger?: { sendCommand: ReturnType<typeof vi.fn> } } }>,
  backgroundHosts: [] as Array<{ options: Record<string, unknown>; contentView: { addChildView: ReturnType<typeof vi.fn>; removeChildView: ReturnType<typeof vi.fn> }; close: ReturnType<typeof vi.fn>; setIgnoreMouseEvents: ReturnType<typeof vi.fn>; showInactive: ReturnType<typeof vi.fn> }>,
  useDebugger: false,
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
      BaseWindow: class extends EventEmitter {
        contentView = { addChildView: vi.fn(), removeChildView: vi.fn() };
        close = vi.fn(() => this.emit("closed"));
        isDestroyed = vi.fn(() => false);
        setIgnoreMouseEvents = vi.fn();
        showInactive = vi.fn();
        constructor(readonly options: Record<string, unknown>) { super(); mock.backgroundHosts.push(this); }
      },
      WebContentsView: class {
        webContents: EventEmitter & {
          session: unknown;
          setWindowOpenHandler: () => void;
          close: () => void;
          loadURL: ReturnType<typeof vi.fn>;
          executeJavaScript: ReturnType<typeof vi.fn>;
          debugger?: { sendCommand: ReturnType<typeof vi.fn> };
        };
        setVisible = vi.fn();
        setBounds = vi.fn();
        readonly webPreferences: Record<string, unknown>;
        constructor({ webPreferences }: { webPreferences: { session?: unknown; partition?: string } }) {
          this.webPreferences = webPreferences;
          let debuggerAttached = false;
          this.webContents = Object.assign(new EventEmitter(), {
            session: webPreferences.session ?? getSession(webPreferences.partition!),
            setWindowOpenHandler: () => {}, close: () => {},
            loadURL: vi.fn().mockResolvedValue(undefined),
            executeJavaScript: vi.fn().mockResolvedValue(true),
            ...(mock.useDebugger ? { debugger: {
              isAttached: () => debuggerAttached,
              attach: vi.fn(() => { debuggerAttached = true; }),
              sendCommand: vi.fn().mockResolvedValue({}),
            } } : {}),
          });
          mock.views.push(this);
        }
        setBackgroundColor() {}
      },
    };
  },
}));
import { AIHubManager } from "./manager";
const roots: string[] = [];
afterEach(() => { mock.sessions.clear(); mock.views.length = 0; mock.backgroundHosts.length = 0; mock.useDebugger = false; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
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
    expect(capture).toEqual([{ siteId: "chatgpt", ok: true, strategy: "chatgpt", messages: [], generating: false, pendingContinue: false }]);
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

  it("keeps background Electron views active outside the visible window", async () => {
    mock.useDebugger = true;
    const root = mkdtempSync(join(tmpdir(), "hub-manager-background-"));
    roots.push(root);
    const removeChildView = vi.fn();
    const manager = new AIHubManager({
      configPath: join(root, "config.json"),
      getWindow: () => ({
        contentView: { addChildView: vi.fn(), removeChildView },
        getContentBounds: () => ({ x: 0, y: 0, width: 1440, height: 900 }),
      }) as never,
    });

    await manager.openSite("deepseek", { applySavedLayout: false, conversationId: "local-session-1" });

    expect(mock.views).toHaveLength(1);
    expect(mock.views[0].webPreferences).toMatchObject({ backgroundThrottling: false });
    expect(mock.views[0].setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 1200, height: 800 });
    expect(mock.views[0].setVisible).toHaveBeenLastCalledWith(true);
    expect(mock.views[0].webContents.debugger?.sendCommand).toHaveBeenCalledWith(
      "Emulation.setFocusEmulationEnabled",
      { enabled: true },
    );
    expect(mock.backgroundHosts).toHaveLength(1);
    expect(mock.backgroundHosts[0].contentView.addChildView).toHaveBeenCalledWith(mock.views[0]);
    expect(mock.backgroundHosts[0].options).toMatchObject({ show: false, x: -20_000, y: -20_000, opacity: 0, focusable: false });
    expect(mock.backgroundHosts[0].setIgnoreMouseEvents).toHaveBeenCalledWith(true);
    expect(mock.backgroundHosts[0].showInactive).toHaveBeenCalledOnce();
    expect(removeChildView).not.toHaveBeenCalled();
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

  it.each([
    ["first turn from the home page", "https://chat.deepseek.com/", 0],
    ["post-tool turn in an existing conversation", "https://chat.deepseek.com/a/chat/s-1", 1],
  ])("uses one trusted submit and polls delayed confirmation for %s", async (_case, url, userCount) => {
    vi.useFakeTimers();
    let probeCount = 0;
    const sendCommand = vi.fn(async (method: string, params?: { expression?: string }) => {
      if (method !== "Runtime.evaluate") return {};
      const expression = params?.expression ?? "";
      if (expression.includes("const baseline =")) return { result: { value: { url, userCount } } };
      if (expression.includes("const before = new URL")) {
        probeCount += 1;
        return { result: { value: { submitted: probeCount >= 3, navigated: url.endsWith("/"), userCount: userCount + 1 } } };
      }
      return { result: { value: true } };
    });
    const webContents = { debugger: { isAttached: () => true, attach: vi.fn(), sendCommand } };
    const { manager } = makeManager();
    const pending = (manager as any).sendTextViaCdp(webContents, "deepseek", "hello");

    await vi.advanceTimersByTimeAsync(12_000);
    await expect(pending).resolves.toBeUndefined();
    expect(sendCommand.mock.calls.filter(([method]) => method === "Input.dispatchKeyEvent")).toHaveLength(2);
    vi.useRealTimers();
  });

  it("does not resubmit when confirmation never arrives", async () => {
    vi.useFakeTimers();
    const sendCommand = vi.fn(async (method: string, params?: { expression?: string }) => {
      if (method !== "Runtime.evaluate") return {};
      const expression = params?.expression ?? "";
      if (expression.includes("const baseline =")) return { result: { value: { url: "https://chat.deepseek.com/a/chat/s-1", userCount: 1 } } };
      if (expression.includes("const before = new URL")) return { result: { value: { submitted: false, navigated: false, userCount: 1 } } };
      return { result: { value: true } };
    });
    const webContents = { debugger: { isAttached: () => true, attach: vi.fn(), sendCommand } };
    const { manager } = makeManager();
    const pending = (manager as any).sendTextViaCdp(webContents, "deepseek", "hello");
    const rejected = expect(pending).rejects.toThrow("submit-not-confirmed");

    await vi.advanceTimersByTimeAsync(12_000);
    await rejected;
    expect(sendCommand.mock.calls.filter(([method]) => method === "Input.dispatchKeyEvent")).toHaveLength(2);
    vi.useRealTimers();
  });

  it("submits a DeepSeek source attachment once after long text conversion", async () => {
    vi.useFakeTimers();
    let sendTargetCalls = 0;
    let probeCalls = 0;
    const sendCommand = vi.fn(async (method: string, params?: { expression?: string }) => {
      if (method !== "Runtime.evaluate") return {};
      const expression = params?.expression ?? "";
      if (expression.includes("const baseline =")) {
        return { result: { value: { url: "https://chat.deepseek.com/", userCount: 0, outputCount: 0, inputLength: 20_000 } } };
      }
      if (expression.includes("const before = new URL")) {
        probeCalls += 1;
        const outputCount = probeCalls >= 2 ? 1 : 0;
        return { result: { value: {
          submitted: outputCount > 0,
          navigated: true,
          userCount: 0,
          outputCount,
          inputLength: 0,
          hasSourceAttachment: true,
        } } };
      }
      if (expression.includes("const semantic =")) {
        sendTargetCalls += 1;
        return { result: { value: { clicked: true } } };
      }
      return { result: { value: true } };
    });
    const webContents = { debugger: { isAttached: () => true, attach: vi.fn(), sendCommand } };
    const { manager } = makeManager();
    const pending = (manager as any).sendTextViaCdp(webContents, "deepseek", "long prompt");

    await vi.advanceTimersByTimeAsync(12_000);
    await expect(pending).resolves.toBeUndefined();
    expect(sendTargetCalls).toBe(2);
    expect(sendCommand.mock.calls.filter(([method]) => method === "Input.dispatchKeyEvent")).toHaveLength(0);
    vi.useRealTimers();
  });

  it("filters the page title and labels messages from the per-conversation send map", async () => {
    const { manager } = makeManager();
    const conversationId = "mapped-session";
    const sent = "【Agent 转发 · unique-anchor】\n发布 npm";
    await manager.openSite("deepseek", { conversationId });
    expect(await manager.broadcast(sent, ["deepseek"], [], conversationId)).toEqual([{ siteId: "deepseek", ok: true }]);
    (mock.views[0] as any).webContents.executeJavaScript.mockResolvedValue({
      strategy: "tool-protocol",
      generating: true,
      debug: { title: "发布npm gitee - DeepSeek" },
      messages: [
        { role: "assistant", text: "发布npm gitee" },
        { role: "assistant", text: sent },
        { role: "assistant", text: '{"type":"tool_call","name":"skill_discover","arguments":{}}' },
      ],
    });

    const [capture] = await manager.captureConversations(["deepseek"], conversationId);
    expect(capture.generating).toBe(true);
    expect(capture.messages).toEqual([
      { role: "user", text: sent },
      { role: "assistant", text: '{"type":"tool_call","name":"skill_discover","arguments":{}}' },
    ]);
  });

  it("uses a trusted CDP mouse click and confirms that continuation started", async () => {
    vi.useFakeTimers();
    mock.useDebugger = true;
    const { manager } = makeManager();
    const conversationId = "continue-confirmed";
    await manager.openSite("deepseek", { applySavedLayout: false, conversationId });
    let resumed = false;
    const sendCommand = mock.views[0].webContents.debugger!.sendCommand;
    sendCommand.mockImplementation(async (method: string, params?: { type?: string; expression?: string }) => {
      if (method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased") resumed = true;
      if (method !== "Runtime.evaluate") return {};
      if (params?.expression?.includes("return { found: true, clickable")) {
        return { result: { value: { found: true, clickable: true, x: 718, y: 447 } } };
      }
      return { result: { value: {
        generating: resumed,
        pendingContinue: !resumed,
        messages: [{ role: "assistant", text: "partial reply" }],
      } } };
    });

    const pending = manager.continueGeneration(["deepseek"], conversationId);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toEqual([{ siteId: "deepseek", ok: true }]);
    expect(sendCommand).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
      type: "mouseReleased", x: 718, y: 447, button: "left", clickCount: 1,
    });
    vi.useRealTimers();
  });

  it("does not report success when a trusted continuation click is a no-op", async () => {
    vi.useFakeTimers();
    mock.useDebugger = true;
    const { manager } = makeManager();
    const conversationId = "continue-no-op";
    await manager.openSite("deepseek", { applySavedLayout: false, conversationId });
    const sendCommand = mock.views[0].webContents.debugger!.sendCommand;
    sendCommand.mockImplementation(async (method: string, params?: { expression?: string }) => {
      if (method !== "Runtime.evaluate") return {};
      if (params?.expression?.includes("return { found: true, clickable")) {
        return { result: { value: { found: true, clickable: true, x: 718, y: 447 } } };
      }
      return { result: { value: {
        generating: false,
        pendingContinue: true,
        messages: [{ role: "assistant", text: "partial reply" }],
      } } };
    });

    const pending = manager.continueGeneration(["deepseek"], conversationId);
    await vi.advanceTimersByTimeAsync(7_000);

    await expect(pending).resolves.toEqual([{ siteId: "deepseek", ok: false, reason: "continue-click-unconfirmed" }]);
    expect(sendCommand.mock.calls.filter(([method, params]) => method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased")).toHaveLength(1);
    vi.useRealTimers();
  });

});
