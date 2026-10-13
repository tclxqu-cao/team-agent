import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

function runtime(secure: boolean, installed = false) {
  const listeners: Record<string, (event: any) => unknown> = {};
  const events: any[] = [];
  const register = vi.fn(async () => {});
  const window: any = {
    isSecureContext: secure,
    addEventListener: (name: string, listener: any) => { listeners[name] = listener; },
    dispatchEvent: (event: any) => { events.push(event); return listeners[event.type]?.(event); },
  };
  window.parent = window;
  class Event { constructor(readonly type: string) {} }
  class CustomEvent extends Event { detail: unknown; constructor(type: string, init: any) { super(type); this.detail = init.detail; } }
  runInNewContext(readFileSync(new URL("../public/pwa/install.js", import.meta.url), "utf8"), {
    window, navigator: { userAgent: "Android", serviceWorker: { register } },
    matchMedia: () => ({ matches: installed }), Event, CustomEvent,
  });
  return { window, listeners, events, register };
}

describe("PWA installation entry", () => {
  it("opens manual instructions on ordinary HTTP without registering a service worker", async () => {
    const browser = runtime(false);
    await browser.listeners["agentroam:pwa-install"]({});
    expect(browser.register).not.toHaveBeenCalled();
    expect(browser.events.some(event => event.type === "agentroam:pwa-guide")).toBe(true);
    expect(browser.events.find(event => event.type === "agentroam:pwa-state").detail).toMatchObject({ installed: false });
  });
  it("uses the browser prompt when available and reports installation state", async () => {
    const browser = runtime(true);
    const prompt = vi.fn(async () => {});
    browser.listeners.beforeinstallprompt({ preventDefault: vi.fn(), prompt, userChoice: Promise.resolve({ outcome: "accepted" }) });
    await browser.listeners["agentroam:pwa-install"]({});
    expect(prompt).toHaveBeenCalledOnce();
    expect(browser.events.some(event => event.type === "agentroam:pwa-guide")).toBe(false);
    browser.listeners.appinstalled({});
    expect(browser.events.at(-1).detail).toMatchObject({ installed: true, available: false });
    expect(browser.register).toHaveBeenCalledOnce();
  });
  it("keeps a useful instruction entry after installation", async () => {
    const browser = runtime(true, true);
    await browser.listeners["agentroam:pwa-install"]({});
    expect(browser.events.at(-1).type).toBe("agentroam:pwa-guide");
  });
});
