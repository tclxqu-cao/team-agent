import { describe, expect, it } from "vitest";
import { readRemoteDesktopVisibility, REMOTE_DESKTOP_VISIBILITY_TYPE } from "./RemoteDesktopTabBridge";

describe("remote desktop tab visibility", () => {
  const source = {} as MessageEventSource;
  const event = { data: { type: REMOTE_DESKTOP_VISIBILITY_TYPE, visible: false }, origin: "https://agent.test", source };
  it("accepts show and hide from the parent shell", () => {
    expect(readRemoteDesktopVisibility(event, event.origin, source)).toBe(false);
    expect(readRemoteDesktopVisibility({ ...event, data: { ...event.data, visible: true } }, event.origin, source)).toBe(true);
  });
  it("rejects unrelated frames, origins, and malformed visibility", () => {
    expect(readRemoteDesktopVisibility(event, "https://other.test", source)).toBeNull();
    expect(readRemoteDesktopVisibility(event, event.origin, null)).toBeNull();
    expect(readRemoteDesktopVisibility({ ...event, data: { ...event.data, visible: "false" } }, event.origin, source)).toBeNull();
  });
});
