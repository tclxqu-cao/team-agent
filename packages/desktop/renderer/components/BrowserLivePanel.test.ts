import { describe, expect, it } from "vitest";
import type { BrowserLiveSession } from "../global";
import { remoteFieldContains, selectBrowserLiveSessionId, touchScrollDelta } from "./BrowserLivePanel";

function session(id: string, agentSessionId: string): BrowserLiveSession {
  return {
    id,
    agentSessionId,
    backend: "ego-browser",
    browserSessionId: `ego:${id}`,
    title: id,
    url: "https://example.com",
    viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
    transport: "cdp-jpeg-ws",
    availability: "ready",
    state: "agent-controlled",
    online: true,
    frameSequence: 1,
    updatedAt: 1,
    viewerCount: 0,
    isController: false,
    controlledByAnotherViewer: false,
  };
}

describe("browser live session selection", () => {
  it("selects a session that arrives after the panel was opened empty", () => {
    expect(selectBrowserLiveSessionId(null, [session("live-1", "agent-1")], "agent-1"))
      .toBe("live-1");
  });

  it("preserves an explicit current selection", () => {
    expect(selectBrowserLiveSessionId("live-2", [session("live-1", "agent-1")], "agent-1"))
      .toBe("live-2");
  });

  it("selects the desktop live session when it is the only one", () => {
    const desktop: BrowserLiveSession = {
      ...session("desktop:primary", ""),
      backend: "desktop",
      browserSessionId: undefined,
      title: "桌面屏幕",
      url: "",
    };
    expect(selectBrowserLiveSessionId(null, [desktop])).toBe("desktop:primary");
  });
});

describe("remote editable field hit test", () => {
  const viewport = { width: 1440, height: 900 };
  const field = { x: 700, y: 400, w: 200, h: 40 };

  it("hits inside the remembered field and near its edges", () => {
    expect(remoteFieldContains(field, viewport, 0.55, 0.46)).toBe(true);
    expect(remoteFieldContains(field, viewport, 0.49, 0.445)).toBe(true); // 2% pad
    expect(remoteFieldContains(field, viewport, 0.1, 0.1)).toBe(false);
  });

  it("never hits without a remembered field or a viewport", () => {
    expect(remoteFieldContains(null, viewport, 0.55, 0.46)).toBe(false);
    expect(remoteFieldContains(field, null, 0.55, 0.46)).toBe(false);
    expect(remoteFieldContains(field, { width: 0, height: 0 }, 0.55, 0.46)).toBe(false);
  });
});

describe("two-finger remote scroll", () => {
  it("maps swipe direction to wheel deltas with natural scrolling", () => {
    // Swiping up scrolls the remote content down.
    expect(touchScrollDelta({ x: 100, y: 200 }, { x: 100, y: 120 })).toEqual({ deltaX: 0, deltaY: 80 });
    // Swiping left scrolls right.
    expect(touchScrollDelta({ x: 200, y: 100 }, { x: 120, y: 100 })).toEqual({ deltaX: 80, deltaY: 0 });
  });

  it("drops sub-pixel jitter below the threshold", () => {
    expect(touchScrollDelta({ x: 100, y: 100 }, { x: 101, y: 101 })).toBeNull();
    expect(touchScrollDelta({ x: 100, y: 100 }, { x: 99.6, y: 97.4 })).toEqual({ deltaX: 0, deltaY: 3 });
  });
});
