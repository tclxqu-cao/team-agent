import { describe, expect, it } from "vitest";
import {
  parseWebappReadyMessage,
  readWebappReadyMessage,
  WEBAPP_READY_MESSAGE_TYPE,
} from "./webappReady";

describe("parseWebappReadyMessage", () => {
  it("accepts the ready message", () => {
    expect(parseWebappReadyMessage({ type: WEBAPP_READY_MESSAGE_TYPE })).toEqual({
      type: WEBAPP_READY_MESSAGE_TYPE,
    });
  });

  it.each([null, {}, "ready", { type: "other" }])("rejects malformed data %#", (data) => {
    expect(parseWebappReadyMessage(data)).toBeNull();
  });
});

describe("readWebappReadyMessage", () => {
  const frame = {} as Window;
  const data = { type: WEBAPP_READY_MESSAGE_TYPE };

  it("accepts only the expected origin and iframe source", () => {
    expect(readWebappReadyMessage(
      { data, origin: "http://192.168.0.104:3100", source: frame },
      "http://192.168.0.104:3100",
      frame,
    )).toEqual(data);
  });

  it("rejects a different origin or window", () => {
    expect(readWebappReadyMessage(
      { data, origin: "http://other-host:3100", source: frame },
      "http://192.168.0.104:3100",
      frame,
    )).toBeNull();
    expect(readWebappReadyMessage(
      { data, origin: "http://192.168.0.104:3100", source: {} as Window },
      "http://192.168.0.104:3100",
      frame,
    )).toBeNull();
  });
});
