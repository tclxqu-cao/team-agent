import { describe, expect, it, vi } from "vitest";
// @ts-expect-error MV3 module is shipped as JavaScript.
import { AutoConnect, DISCOVERY_ALARM } from "../../chrome-extension/auto-connect.js";
// @ts-expect-error MV3 module is shipped as JavaScript.
import { siteForUrl } from "../../chrome-extension/bridge-client.js";

function setup(paused = false) {
  const event = () => { const listeners: Array<(...args: any[]) => void> = []; return { addListener: (fn: (...args: any[]) => void) => listeners.push(fn), fire: (...args: any[]) => listeners.forEach((fn) => fn(...args)) }; };
  let tabs: any[] = [];
  const api = {
    tabs: { query: vi.fn(async () => tabs), onUpdated: event(), onRemoved: event() },
    alarms: { create: vi.fn(), onAlarm: event() },
    storage: { local: { get: vi.fn(async () => ({ autoConnectPaused: paused })), set: vi.fn() } },
  };
  const bridge: any = {
    ready: false, tabs: new Map(),
    send: vi.fn(),
    status: () => ({ connected: bridge.ready, sites: [...bridge.tabs.keys()] }),
    connect: vi.fn(async () => { bridge.ready = true; bridge.onReady?.(); }),
    attach: vi.fn(async (id: number) => { const tab = tabs.find((tab) => tab.id === id); bridge.tabs.set(siteForUrl(tab.url), { id }); }),
    detach: vi.fn(async (site: string) => { bridge.tabs.delete(site); }),
    disconnect: vi.fn(async () => { bridge.ready = false; bridge.tabs.clear(); }),
  };
  const load = vi.fn(async () => ({ port: 19473, token: "a".repeat(64) }));
  const controller = new AutoConnect(api, bridge, load);
  return { api, bridge, load, controller, setTabs: (value: any[]) => { tabs = value; } };
}

describe("automatic Chrome connection", () => {
  it("bootstraps without stored pairing and discovers one preferred tab per provider", async () => {
    const { controller, bridge, api, setTabs } = setup();
    setTabs([{ id: 1, url: "https://chatgpt.com/c/old" }, { id: 2, active: true, url: "https://chatgpt.com/" }, { id: 3, url: "https://gemini.google.com/app" }, { id: 4, url: "https://grok.com/" }, { id: 5, url: "https://grok.com/login" }, { id: 6, url: "https://evil.test/" }]);
    await controller.start();
    expect(bridge.connect).toHaveBeenCalledTimes(1);
    expect([...bridge.tabs.entries()]).toEqual([["chatgpt", { id: 2 }], ["gemini", { id: 3 }], ["grok", { id: 4 }]]);
    expect(api.alarms.create).toHaveBeenCalledWith(DISCOVERY_ALARM, { periodInMinutes: 0.5 });
    await Promise.all([controller.discover(), controller.discover(), controller.discover()]);
    expect(bridge.attach).toHaveBeenCalledTimes(3);
    setTabs([{ id: 7, active: true, url: "https://chatgpt.com/c/other" }]);
    await controller.discover();
    expect(bridge.tabs.get("chatgpt").id).toBe(2);
  });
  it("recovers when the desktop starts later and discovers tabs after login completes", async () => {
    const { controller, bridge, api, setTabs } = setup();
    bridge.connect.mockRejectedValueOnce(new Error("offline"));
    await controller.start();
    expect(controller.status().connected).toBe(false);
    setTabs([{ id: 1, url: "https://grok.com/login" }]);
    api.alarms.onAlarm.fire({ name: DISCOVERY_ALARM });
    await vi.waitFor(() => expect(bridge.ready).toBe(true));
    expect(bridge.tabs.size).toBe(0);
    setTabs([{ id: 1, url: "https://grok.com/", status: "complete" }]);
    api.tabs.onUpdated.fire(1, { status: "complete" });
    await vi.waitFor(() => expect(bridge.tabs.has("grok")).toBe(true));
    await bridge.disconnect();
    api.alarms.onAlarm.fire({ name: DISCOVERY_ALARM });
    await vi.waitFor(() => expect(bridge.tabs.has("grok")).toBe(true));
  });
  it("persists pause across worker restart and honors a canceled Chrome debugger banner", async () => {
    const { controller, bridge, api, setTabs } = setup(true);
    setTabs([{ id: 1, url: "https://chatgpt.com/" }]);
    await controller.start();
    expect(bridge.ready).toBe(true);
    expect(bridge.attach).not.toHaveBeenCalled();
    expect(bridge.send).toHaveBeenLastCalledWith({ type: "auto-connect-status", paused: true });
    await bridge.onResume();
    expect(bridge.tabs.size).toBe(1);
    bridge.onUserDetach();
    await vi.waitFor(() => expect(bridge.tabs.size).toBe(0));
    expect(bridge.ready).toBe(true);
    api.alarms.onAlarm.fire({ name: DISCOVERY_ALARM });
    api.tabs.onUpdated.fire(1, { status: "complete" });
    expect(controller.status().paused).toBe(true);
    expect(bridge.connect).toHaveBeenCalledTimes(1);
    expect(api.storage.local.set).toHaveBeenLastCalledWith({ autoConnectPaused: true });
    expect(bridge.send).toHaveBeenLastCalledWith({ type: "auto-connect-status", paused: true });
    // A desktop restart must preserve the pause while restoring the control channel.
    await bridge.disconnect();
    await controller.tick();
    expect(bridge.ready).toBe(true);
    expect(bridge.tabs.size).toBe(0);
    await bridge.onResume();
    expect(bridge.tabs.size).toBe(1);
  });
  it("only connects the control channel after pause while credentials are still loading", async () => {
    const { controller, bridge, load } = setup();
    let release!: (value: any) => void;
    load.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const start = controller.start();
    await vi.waitFor(() => expect(release).toBeDefined());
    await controller.setPaused(true);
    release({ port: 19473, token: "a".repeat(64) });
    await start;
    expect(bridge.ready).toBe(true);
    expect(bridge.attach).not.toHaveBeenCalled();
    expect(bridge.send).toHaveBeenLastCalledWith({ type: "auto-connect-status", paused: true });
  });
  it("cleans up an attachment completing after pause", async () => {
    const { controller, bridge, setTabs } = setup();
    await controller.start();
    setTabs([{ id: 1, url: "https://grok.com/" }]);
    let release!: () => void;
    bridge.attach.mockImplementationOnce(() => new Promise<void>((resolve) => { release = () => { bridge.tabs.set("grok", { id: 1 }); resolve(); }; }));
    const discovery = controller.discover();
    await vi.waitFor(() => expect(release).toBeDefined());
    await controller.setPaused(true); release(); await discovery;
    expect(bridge.tabs.size).toBe(0);
  });
  it("isolates authentication failures without preventing other providers from attaching", async () => {
    const { controller, bridge, setTabs } = setup();
    setTabs([{ id: 1, url: "https://chatgpt.com/" }, { id: 2, url: "https://grok.com/" }]);
    bridge.attach.mockRejectedValueOnce(new Error("chrome-auth-required"));
    await controller.start();
    expect(bridge.tabs.has("grok")).toBe(true);
  });
});
