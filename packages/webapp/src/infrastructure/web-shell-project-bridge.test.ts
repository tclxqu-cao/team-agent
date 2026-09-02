import {
  WEBAPP_PROJECT_RESPONSE_TYPE,
} from "../../../core/src/domain/web-console/WebProjectBridge";
import { describe, expect, it, vi } from "vitest";
import { WebShellProjectBridge } from "./web-shell-project-bridge";

function fakeBridgeWindow(standalone = false) {
  const listeners: Array<(event: MessageEvent) => void> = [];
  const parent = { postMessage: vi.fn() };
  const context = {
    location: { origin: "https://agent.test" },
    parent: standalone ? null as unknown : parent,
    addEventListener: (_type: string, listener: EventListener) => listeners.push(listener as never),
    removeEventListener: (_type: string, listener: EventListener) => {
      const index = listeners.indexOf(listener as never);
      if (index >= 0) listeners.splice(index, 1);
    },
  };
  if (standalone) context.parent = context as never;
  return {
    context,
    parent,
    respond(data: unknown, origin = "https://agent.test", source: unknown = parent) {
      listeners.forEach((listener) => listener({ data, origin, source } as MessageEvent));
    },
  };
}

describe("WebShellProjectBridge", () => {
  it("correlates a same-origin parent response", async () => {
    const fake = fakeBridgeWindow();
    const bridge = new WebShellProjectBridge(fake.context as never, 100);
    const result = bridge.request("project:list");
    expect(fake.parent.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      id: 1,
      method: "project:list",
    }), "https://agent.test");
    fake.respond({
      type: WEBAPP_PROJECT_RESPONSE_TYPE,
      id: 1,
      ok: true,
      result: { projects: [{ id: "p1" }] },
    });
    await expect(result).resolves.toEqual({ projects: [{ id: "p1" }] });
    bridge.dispose();
  });

  it("rejects responses from another origin or source", async () => {
    vi.useFakeTimers();
    const fake = fakeBridgeWindow();
    const bridge = new WebShellProjectBridge(fake.context as never, 20);
    const result = bridge.request("project:list");
    const rejected = expect(result).rejects.toMatchObject({ code: "WEB_SHELL_TIMEOUT" });
    fake.respond({ type: WEBAPP_PROJECT_RESPONSE_TYPE, id: 1, ok: true, result: {} }, "https://evil.test");
    fake.respond({ type: WEBAPP_PROJECT_RESPONSE_TYPE, id: 1, ok: true, result: {} }, "https://agent.test", {});
    await vi.advanceTimersByTimeAsync(25);
    await rejected;
    bridge.dispose();
    vi.useRealTimers();
  });

  it("fails clearly outside the parent Web shell", async () => {
    const fake = fakeBridgeWindow(true);
    const bridge = new WebShellProjectBridge(fake.context as never);
    await expect(bridge.request("project:roots")).rejects.toMatchObject({ code: "WEB_SHELL_REQUIRED" });
    bridge.dispose();
  });
});
