import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { announceWebappReady, WEBAPP_READY_MESSAGE_TYPE } from "./webapp-ready";

let originalWindow: unknown;

beforeEach(() => {
  originalWindow = (globalThis as { window?: unknown }).window;
});

afterEach(() => {
  (globalThis as { window?: unknown }).window = originalWindow;
});

describe("announceWebappReady", () => {
  it("is a noop when the webapp runs outside the shell", () => {
    const win: Record<string, unknown> = { location: { origin: "http://localhost" } };
    Object.defineProperty(win, "parent", { get: () => win });
    (globalThis as { window: unknown }).window = win;

    announceWebappReady();
  });

  it("notifies the same-origin parent when React has mounted", () => {
    const parent = { postMessage: vi.fn() };
    const win = { parent, location: { origin: "http://localhost" } };
    (globalThis as { window: unknown }).window = win;

    announceWebappReady();

    expect(parent.postMessage).toHaveBeenCalledWith(
      { type: WEBAPP_READY_MESSAGE_TYPE },
      "http://localhost",
    );
  });
});
