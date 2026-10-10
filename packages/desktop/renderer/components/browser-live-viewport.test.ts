import { afterEach, describe, expect, it, vi } from "vitest";
import { intersectBrowserLiveViewport, trackBrowserLiveViewport } from "./browser-live-viewport";

const rect = (height: number, top = 0, width = 390, left = 0) => ({ height, top, width, left });

function browserWindow(height = 806) {
  const viewport = Object.assign(new EventTarget(), {
    height, width: 390, offsetTop: 0, offsetLeft: 0,
  });
  const document = Object.assign(new EventTarget(), { fullscreenElement: null as Element | null });
  const view = Object.assign(new EventTarget(), {
    visualViewport: viewport, document, innerHeight: height, innerWidth: 390,
    location: { origin: "http://localhost:3000" },
    frameElement: null as Element | null,
    parent: null as unknown as Window,
    requestAnimationFrame: (callback: FrameRequestCallback) => windowTimer(() => callback(0), 16),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    setTimeout: windowTimer,
    clearTimeout: (id: number) => clearTimeout(id),
  });
  view.parent = view as unknown as Window;
  return view;
}

function windowTimer(callback: () => void, timeout: number): number {
  return setTimeout(callback, timeout) as unknown as number;
}

function targetElement() {
  const values = new Map<string, string>();
  const element = { style: {
    setProperty: (name: string, value: string) => values.set(name, value),
    removeProperty: (name: string) => values.delete(name),
  } } as unknown as HTMLElement;
  return { element, values };
}

afterEach(() => vi.useRealTimers());

describe("remote desktop visible viewport", () => {
  it("keeps the picture above the keyboard when an iframe retains its full height", () => {
    expect(intersectBrowserLiveViewport(rect(806), rect(420), rect(806, 38)))
      .toEqual(rect(382));
  });

  it("accounts for Safari panning and horizontal offsets inside the frame", () => {
    expect(intersectBrowserLiveViewport(rect(806), rect(420, 110, 360, 20), rect(806, 38)))
      .toEqual(rect(420, 72, 360, 20));
    // The shell has followed the visual viewport; do not apply its offset twice.
    expect(intersectBrowserLiveViewport(rect(382), rect(420, 110), rect(382, 148)))
      .toEqual(rect(382));
  });

  it("never creates negative dimensions for an offscreen frame", () => {
    const visible = intersectBrowserLiveViewport(rect(806), rect(420), rect(806, 600));
    expect(visible.height).toBe(0);
    expect(visible.width).toBe(390);
  });

  it("follows local keyboard opening, panning and closing", () => {
    vi.useFakeTimers();
    const view = browserWindow(844);
    const { element, values } = targetElement();
    const stop = trackBrowserLiveViewport(element, view as unknown as Window);
    expect(values.get("--browser-live-height")).toBe("844px");
    view.visualViewport.height = 420;
    view.visualViewport.offsetTop = 110;
    view.visualViewport.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(16);
    expect(values.get("--browser-live-height")).toBe("420px");
    expect(values.get("--browser-live-top")).toBe("110px");
    view.visualViewport.height = 844;
    view.visualViewport.offsetTop = 0;
    view.visualViewport.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(250);
    expect(values.get("--browser-live-height")).toBe("844px");
    expect(values.get("--browser-live-top")).toBe("0px");
    stop();
  });

  it("follows the parent keyboard even without an iframe resize, and releases its clipping in native fullscreen", () => {
    vi.useFakeTimers();
    const view = browserWindow();
    const parent = browserWindow(844);
    view.parent = parent as unknown as Window;
    view.frameElement = { getBoundingClientRect: () => rect(806, 38) } as unknown as Element;
    const { element, values } = targetElement();
    const stop = trackBrowserLiveViewport(element, view as unknown as Window);
    parent.visualViewport.height = 420;
    parent.visualViewport.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(250);
    expect(values.get("--browser-live-height")).toBe("382px");
    view.document.fullscreenElement = {} as Element;
    view.document.dispatchEvent(new Event("fullscreenchange"));
    vi.advanceTimersByTime(250);
    expect(values.get("--browser-live-height")).toBe("806px");
    view.document.fullscreenElement = null;
    view.document.dispatchEvent(new Event("fullscreenchange"));
    vi.advanceTimersByTime(250);
    expect(values.get("--browser-live-height")).toBe("382px");
    stop();
  });

  it("removes listeners and pending work when the panel closes", () => {
    vi.useFakeTimers();
    const view = browserWindow();
    const { element, values } = targetElement();
    const stop = trackBrowserLiveViewport(element, view as unknown as Window);
    view.visualViewport.dispatchEvent(new Event("resize"));
    stop();
    view.visualViewport.height = 420;
    view.visualViewport.dispatchEvent(new Event("resize"));
    vi.runAllTimers();
    expect(values.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
