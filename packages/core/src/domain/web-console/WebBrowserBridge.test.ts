import { describe, expect, it } from "vitest";
import {
  WEBAPP_BROWSER_EVENT_TYPE,
  WEBAPP_BROWSER_BINARY_FRAME_TYPE,
  WEBAPP_BROWSER_REQUEST_TYPE,
  parseWebBrowserEvent,
  parseWebBrowserBinaryFrame,
  parseWebBrowserRequest,
  readWebBrowserRequest,
} from "./WebBrowserBridge";

describe("WebBrowserBridge", () => {
  it("accepts only supported browser methods", () => {
    expect(parseWebBrowserRequest({
      type: WEBAPP_BROWSER_REQUEST_TYPE,
      id: 1,
      method: "browser:takeover",
      payload: { sessionId: "browser-1" },
    })?.method).toBe("browser:takeover");
    expect(parseWebBrowserRequest({
      type: WEBAPP_BROWSER_REQUEST_TYPE,
      id: 2,
      method: "browser:publish",
      payload: {},
    })).toBeNull();
  });

  it("checks iframe origin and source", () => {
    const source = {} as MessageEventSource;
    const event = {
      origin: "https://agentroam.local",
      source,
      data: { type: WEBAPP_BROWSER_REQUEST_TYPE, id: 1, method: "browser:list", payload: {} },
    };
    expect(readWebBrowserRequest(event, event.origin, source)).not.toBeNull();
    expect(readWebBrowserRequest(event, "https://other.local", source)).toBeNull();
  });

  it("rejects non-browser event injection", () => {
    expect(parseWebBrowserEvent({
      type: WEBAPP_BROWSER_EVENT_TYPE,
      event: { type: "browser:frame", sessionId: "browser-1" },
    })).not.toBeNull();
    expect(parseWebBrowserEvent({
      type: WEBAPP_BROWSER_EVENT_TYPE,
      event: { type: "term:data" },
    })).toBeNull();
  });

  it("accepts transferred JPEG frame buffers only", () => {
    expect(parseWebBrowserBinaryFrame({
      type: WEBAPP_BROWSER_BINARY_FRAME_TYPE,
      channelId: 4,
      sequence: 9,
      data: new ArrayBuffer(32),
    })).toMatchObject({ channelId: 4, sequence: 9 });
    expect(parseWebBrowserBinaryFrame({
      type: WEBAPP_BROWSER_BINARY_FRAME_TYPE,
      channelId: 4,
      sequence: 9,
      data: "base64",
    })).toBeNull();
  });
});
