import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { BrowserLiveSession } from "../global";
import { decodePcm16Base64, encodePcm16Base64, isStaleControlReply, prepareVoiceAudio, remoteFieldContains, selectBrowserLiveSessionId, touchScrollDelta } from "./BrowserLivePanel";

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

  it("keeps screen switching in the resolution toolbar", () => {
    const source = readFileSync(new URL("./BrowserLivePanel.tsx", import.meta.url), "utf8");
    const toolbarStart = source.indexOf('className="browser-live-zoom"');
    const tabsStart = source.indexOf('className="browser-live-session-tabs"');
    const surfaceContentStart = source.indexOf('className="browser-live-viewport"');

    expect(toolbarStart).toBeGreaterThan(-1);
    expect(tabsStart).toBeGreaterThan(toolbarStart);
    expect(tabsStart).toBeLessThan(surfaceContentStart);
    expect(source).not.toContain("has-session-tabs");
  });

  it("shows desktop quality without duplicating a single physical display", () => {
    const source = readFileSync(new URL("./BrowserLivePanel.tsx", import.meta.url), "utf8");

    expect(source).toContain("liveDisplays.length > 1");
    expect(source).not.toContain('selectedId === "cli-desktop:primary"');
    expect(source).toContain("{isDesktop && (\n                <LiveViewSelect label=\"视频画质\"");
  });
});

describe("stale control reply guard", () => {
  const controller = (state: BrowserLiveSession["state"]): BrowserLiveSession => ({
    ...session("desktop:primary", ""),
    backend: "desktop",
    browserSessionId: undefined,
    title: "桌面屏幕",
    url: "",
    state,
    isController: true,
  });

  it("drops a pending-handoff reply that arrives after the confirm", () => {
    expect(isStaleControlReply(controller("user-controlled"), controller("handoff-requested"))).toBe(true);
  });

  it("lets every other transition through", () => {
    expect(isStaleControlReply(controller("agent-controlled"), controller("handoff-requested"))).toBe(false);
    expect(isStaleControlReply(controller("return-requested"), controller("handoff-requested"))).toBe(false);
    expect(isStaleControlReply(controller("user-controlled"), controller("agent-controlled"))).toBe(false);
    expect(isStaleControlReply(controller("user-controlled"), controller("user-controlled"))).toBe(false);
    expect(isStaleControlReply(null, controller("handoff-requested"))).toBe(false);
  });

  it("drops a pending-return reply that arrives after the release confirm", () => {
    expect(isStaleControlReply(controller("agent-controlled"), controller("return-requested"))).toBe(true);
  });

  it("does not regress a viewer whose own view shows no control", () => {
    // Another viewer holds control; our own view is not user-controlled.
    const watching = { ...controller("user-controlled"), isController: false };
    expect(isStaleControlReply(watching, controller("handoff-requested"))).toBe(false);
  });
});

describe("remembered region hit test", () => {
  const viewport = { width: 1440, height: 900 };
  const region = { x: 700, y: 400, w: 200, h: 40 };

  it("hits inside the remembered region and near its edges", () => {
    expect(remoteFieldContains(region, viewport, 0.55, 0.46)).toBe(true);
    expect(remoteFieldContains(region, viewport, 0.49, 0.445)).toBe(true); // 2% pad
    expect(remoteFieldContains(region, viewport, 0.1, 0.1)).toBe(false);
  });

  it("never hits without a remembered region or a viewport", () => {
    expect(remoteFieldContains(null, viewport, 0.55, 0.46)).toBe(false);
    expect(remoteFieldContains(region, null, 0.55, 0.46)).toBe(false);
    expect(remoteFieldContains(region, { width: 0, height: 0 }, 0.55, 0.46)).toBe(false);
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

describe("remote full-duplex audio", () => {
  it("round-trips bounded signed 16-bit PCM", () => {
    const source = new Float32Array([-1, -0.5, 0, 0.5, 0.999]);
    const decoded = decodePcm16Base64(encodePcm16Base64(source), 1)[0];
    expect(decoded).toHaveLength(source.length);
    source.forEach((value, index) => expect(decoded[index]).toBeCloseTo(value, 3));
  });

  it("requires an explicit gesture and stops on backgrounding", () => {
    const source = readFileSync(new URL("./BrowserLivePanel.tsx", import.meta.url), "utf8");
    expect(source).toContain('aria-label="开始语音"');
    expect(source).toContain('echoCancellation: true');
    expect(source).toContain('noiseSuppression: true');
    expect(source).toContain('autoGainControl: true');
    expect(source).toContain('document.addEventListener("visibilitychange"');
    expect(source).toContain('kind: "audio-stop"');
    expect(source).toContain('audioCapabilities?.fullDuplex');
  });
});

describe("remote voice resource lifecycle", () => {
  afterEach(() => vi.unstubAllGlobals());

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((accept) => { resolve = accept; });
    return { promise, resolve };
  }

  function mediaFixture(resume: () => Promise<void> = () => Promise.resolve()) {
    const stop = vi.fn();
    const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;
    const contexts: FakeAudioContext[] = [];
    const audioNode = () => ({ connect: vi.fn(), gain: { value: 1 } });
    class FakeAudioContext {
      destination = {};
      close = vi.fn(async () => {});
      resume = vi.fn(resume);
      createGain = vi.fn(audioNode);
      createMediaStreamSource = vi.fn(audioNode);
      createScriptProcessor = vi.fn(audioNode);
      constructor() { contexts.push(this); }
    }
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(async () => stream) } });
    vi.stubGlobal("window", { AudioContext: FakeAudioContext });
    return { stop, stream, contexts, FakeAudioContext };
  }

  it("releases a late microphone grant after the start was cancelled", async () => {
    const media = mediaFixture();
    const permission = deferred<MediaStream>();
    vi.mocked(navigator.mediaDevices.getUserMedia).mockReturnValue(permission.promise);
    const start = new AbortController();
    const pending = prepareVoiceAudio(start.signal);
    start.abort();
    permission.resolve(media.stream);

    expect(await pending).toBeNull();
    expect(media.stop).toHaveBeenCalledOnce();
    expect(media.contexts).toHaveLength(0);
  });

  it("stops capture immediately while AudioContext resume is pending", async () => {
    const resumed = deferred<void>();
    const media = mediaFixture(() => resumed.promise);
    const start = new AbortController();
    const pending = prepareVoiceAudio(start.signal);
    await vi.waitFor(() => expect(media.contexts).toHaveLength(2));
    start.abort();

    expect(media.stop).toHaveBeenCalledOnce();
    for (const context of media.contexts) expect(context.close).toHaveBeenCalledOnce();
    resumed.resolve();
    expect(await pending).toBeNull();
    for (const context of media.contexts) expect(context.createMediaStreamSource).not.toHaveBeenCalled();
  });

  it("cleans up the microphone and first context if later initialization fails", async () => {
    const media = mediaFixture();
    let created = 0;
    vi.stubGlobal("window", { AudioContext: class extends media.FakeAudioContext {
      constructor() {
        if (created++ === 1) throw new Error("audio context unavailable");
        super();
      }
    } });

    await expect(prepareVoiceAudio(new AbortController().signal)).rejects.toThrow("audio context unavailable");
    expect(media.stop).toHaveBeenCalledOnce();
    expect(media.contexts[0].close).toHaveBeenCalledOnce();
  });

  it("keeps successfully prepared audio alive until it is disposed", async () => {
    const media = mediaFixture();
    const resources = await prepareVoiceAudio(new AbortController().signal);

    expect(resources?.stream).toBe(media.stream);
    expect(media.stop).not.toHaveBeenCalled();
    resources?.dispose();
    resources?.dispose();
    expect(media.stop).toHaveBeenCalledOnce();
    for (const context of media.contexts) expect(context.close).toHaveBeenCalledOnce();
  });
});
