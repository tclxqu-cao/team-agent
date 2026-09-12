import { describe, expect, it } from "vitest";
import {
  WEB_SHELL_OPEN_BROWSER_LIVE_TYPE,
  parseWebShellOpenBrowserLive,
  readWebShellOpenBrowserLive,
} from "./WebShellLiveBridge";

describe("web shell live bridge contract", () => {
  const message = { type: WEB_SHELL_OPEN_BROWSER_LIVE_TYPE };

  it("accepts an open request from the expected frame", () => {
    const source = {} as MessageEventSource;
    expect(readWebShellOpenBrowserLive(
      { data: message, origin: "https://agent.test", source },
      "https://agent.test",
      source,
    )).toEqual(message);
  });

  it("rejects payloads of another type or shape", () => {
    expect(parseWebShellOpenBrowserLive({ type: "agent-web-shell:skin:v1" })).toBeNull();
    expect(parseWebShellOpenBrowserLive(null)).toBeNull();
    expect(parseWebShellOpenBrowserLive("open-browser-live")).toBeNull();
  });

  it("rejects requests from another origin or frame", () => {
    const source = {} as MessageEventSource;
    expect(readWebShellOpenBrowserLive(
      { data: message, origin: "https://evil.test", source },
      "https://agent.test",
      source,
    )).toBeNull();
    expect(readWebShellOpenBrowserLive(
      { data: message, origin: "https://agent.test", source: {} as MessageEventSource },
      "https://agent.test",
      source,
    )).toBeNull();
  });
});
