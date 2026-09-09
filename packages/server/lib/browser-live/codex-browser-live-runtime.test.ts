import { describe, expect, it } from "vitest";
import { BrowserControlGate, guardedObject, viewportFromLayoutMetrics } from "./codex-browser-live-runtime.mjs";

describe("Codex browser live runtime", () => {
  it("blocks browser methods while the WebApp user owns control", async () => {
    const gate = new BrowserControlGate();
    const raw = { nested: { call: (value: string) => `done:${value}` } };
    const guarded = guardedObject(raw, gate);
    expect(guarded.nested.call("one")).toBe("done:one");
    gate.pause();
    expect(() => guarded.nested.call("two")).toThrow("WebApp user");
    gate.resume();
    expect(guarded.nested.call("three")).toBe("done:three");
  });

  it("guards values resolved by async browser methods without proxying the Promise", async () => {
    const gate = new BrowserControlGate();
    const guarded = guardedObject({
      async tab() {
        return { click: () => "clicked" };
      },
    }, gate);

    const tab = await guarded.tab();
    expect(tab.click()).toBe("clicked");
    gate.pause();
    expect(() => tab.click()).toThrow("WebApp user");
  });

  it("reads CSS viewport dimensions from CDP layout metrics", () => {
    expect(viewportFromLayoutMetrics({
      cssVisualViewport: { clientWidth: 1280.4, clientHeight: 719.6 },
    })).toEqual({ width: 1280, height: 720, deviceScaleFactor: 1 });
  });
});
