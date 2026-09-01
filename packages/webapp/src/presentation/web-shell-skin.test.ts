import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const setSkinMock = vi.fn();
  const getStateMock = vi.fn(() => ({ setSkin: setSkinMock }));
  return { setSkinMock, getStateMock };
});

vi.mock("@desktop/renderer/stores/uiStore", () => ({
  useUIStore: { getState: mocks.getStateMock },
}));

import { WEB_SHELL_SKIN_MESSAGE_TYPE, installWebShellSkinBridge } from "./web-shell-skin";

interface FakeWindow {
  window: Record<string, unknown>;
  fireMessage: (data: unknown, source?: unknown, origin?: string) => void;
  listenerCount: () => number;
}

function makeFakeWindow(opts: { isTopLevel: boolean }): FakeWindow {
  const listeners: Array<(event: { origin: string; source: unknown; data: unknown }) => void> = [];
  // The real check is `window.parent === window` — when iframed, parent is the
  // outer window object (identity-unequal); when standalone, parent is self.
  // We model that with a getter: top-level returns self, iframed returns a
  // distinct sentinel object.
  const sentinel = { tag: "fake-parent" };
  const win: Record<string, unknown> = {
    location: { origin: "http://localhost" },
    addEventListener: (type: string, cb: (event: unknown) => void) => {
      if (type === "message") listeners.push(cb as never);
    },
    removeEventListener: (type: string, cb: (event: unknown) => void) => {
      if (type !== "message") return;
      const i = listeners.indexOf(cb as never);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
  Object.defineProperty(win, "parent", {
    get: () => (opts.isTopLevel ? win : sentinel),
  });
  return {
    window: win,
    fireMessage: (data, source = sentinel, origin = "http://localhost") => {
      const evt = { origin, source, data };
      listeners.forEach((cb) => cb(evt));
    },
    listenerCount: () => listeners.length,
  };
}

let originalWindow: unknown;
beforeEach(() => {
  mocks.setSkinMock.mockClear();
  mocks.getStateMock.mockClear();
  originalWindow = (globalThis as { window?: unknown }).window;
});
afterEach(() => {
  (globalThis as { window?: unknown }).window = originalWindow;
});

describe("installWebShellSkinBridge", () => {
  it("is a noop when running standalone (parent === window)", () => {
    const f = makeFakeWindow({ isTopLevel: true });
    (globalThis as { window: unknown }).window = f.window;
    const dispose = installWebShellSkinBridge();
    expect(dispose).toBeTypeOf("function");
    expect(f.listenerCount()).toBe(0);
    dispose();
  });

  it("forwards a valid skin message from the parent window", () => {
    const f = makeFakeWindow({ isTopLevel: false });
    (globalThis as { window: unknown }).window = f.window;
    const dispose = installWebShellSkinBridge();
    expect(f.listenerCount()).toBe(1);
    f.fireMessage({ type: WEB_SHELL_SKIN_MESSAGE_TYPE, skin: "noir" });
    expect(mocks.getStateMock).toHaveBeenCalledTimes(1);
    expect(mocks.setSkinMock).toHaveBeenCalledTimes(1);
    expect(mocks.setSkinMock).toHaveBeenCalledWith("noir");
    dispose();
    expect(f.listenerCount()).toBe(0);
  });

  it("forwards all three known skin ids", () => {
    const f = makeFakeWindow({ isTopLevel: false });
    (globalThis as { window: unknown }).window = f.window;
    const dispose = installWebShellSkinBridge();
    for (const skin of ["pearl", "scifi", "noir"] as const) {
      f.fireMessage({ type: WEB_SHELL_SKIN_MESSAGE_TYPE, skin });
    }
    expect(mocks.setSkinMock.mock.calls).toEqual([["pearl"], ["scifi"], ["noir"]]);
    dispose();
  });

  it("rejects messages from a different origin", () => {
    const f = makeFakeWindow({ isTopLevel: false });
    (globalThis as { window: unknown }).window = f.window;
    const dispose = installWebShellSkinBridge();
    f.fireMessage(
      { type: WEB_SHELL_SKIN_MESSAGE_TYPE, skin: "noir" },
      f.window,
      "https://attacker.example",
    );
    expect(mocks.setSkinMock).not.toHaveBeenCalled();
    dispose();
  });

  it("rejects messages not coming from the parent window", () => {
    const f = makeFakeWindow({ isTopLevel: false });
    (globalThis as { window: unknown }).window = f.window;
    const dispose = installWebShellSkinBridge();
    f.fireMessage(
      { type: WEB_SHELL_SKIN_MESSAGE_TYPE, skin: "noir" },
      { tag: "random-frame" },
    );
    expect(mocks.setSkinMock).not.toHaveBeenCalled();
    dispose();
  });

  it("rejects messages with the wrong type", () => {
    const f = makeFakeWindow({ isTopLevel: false });
    (globalThis as { window: unknown }).window = f.window;
    const dispose = installWebShellSkinBridge();
    f.fireMessage({ type: "some-other-channel", skin: "noir" });
    f.fireMessage({ type: undefined, skin: "noir" });
    f.fireMessage({ type: 42, skin: "noir" });
    expect(mocks.setSkinMock).not.toHaveBeenCalled();
    dispose();
  });

  it("rejects unknown skin ids", () => {
    const f = makeFakeWindow({ isTopLevel: false });
    (globalThis as { window: unknown }).window = f.window;
    const dispose = installWebShellSkinBridge();
    f.fireMessage({ type: WEB_SHELL_SKIN_MESSAGE_TYPE, skin: "rainbow" });
    f.fireMessage({ type: WEB_SHELL_SKIN_MESSAGE_TYPE, skin: undefined });
    f.fireMessage({ type: WEB_SHELL_SKIN_MESSAGE_TYPE, skin: 123 });
    f.fireMessage({ type: WEB_SHELL_SKIN_MESSAGE_TYPE });
    expect(mocks.setSkinMock).not.toHaveBeenCalled();
    dispose();
  });

  it("ignores null / non-object data payloads", () => {
    const f = makeFakeWindow({ isTopLevel: false });
    (globalThis as { window: unknown }).window = f.window;
    const dispose = installWebShellSkinBridge();
    f.fireMessage(null);
    f.fireMessage("string");
    f.fireMessage(42);
    expect(mocks.setSkinMock).not.toHaveBeenCalled();
    dispose();
  });
});
