import { describe, expect, it } from "vitest";
import {
  parseWebappTabSwipeMessage,
  readWebappTabSwipeMessage,
  WEBAPP_TAB_SWIPE_MESSAGE_TYPE,
} from "./webappTabSwipe";

describe("parseWebappTabSwipeMessage", () => {
  it("accepts a valid swipe message", () => {
    expect(parseWebappTabSwipeMessage({
      type: WEBAPP_TAB_SWIPE_MESSAGE_TYPE,
      phase: "move",
      deltaX: -48,
    })).toEqual({
      type: WEBAPP_TAB_SWIPE_MESSAGE_TYPE,
      phase: "move",
      deltaX: -48,
    });
  });

  it.each([
    null,
    {},
    { type: "other", phase: "move", deltaX: 1 },
    { type: WEBAPP_TAB_SWIPE_MESSAGE_TYPE, phase: "start", deltaX: 1 },
    { type: WEBAPP_TAB_SWIPE_MESSAGE_TYPE, phase: "move" },
    { type: WEBAPP_TAB_SWIPE_MESSAGE_TYPE, phase: "move", deltaX: Number.NaN },
    { type: WEBAPP_TAB_SWIPE_MESSAGE_TYPE, phase: "move", deltaX: Number.POSITIVE_INFINITY },
  ])("rejects malformed data %#", (data) => {
    expect(parseWebappTabSwipeMessage(data)).toBeNull();
  });
});

describe("readWebappTabSwipeMessage", () => {
  const data = { type: WEBAPP_TAB_SWIPE_MESSAGE_TYPE, phase: "end", deltaX: -80 };
  const frame = {} as Window;

  it("accepts only the expected origin and iframe source", () => {
    expect(readWebappTabSwipeMessage(
      { data, origin: "http://192.168.0.104:3100", source: frame },
      "http://192.168.0.104:3100",
      frame,
    )).toEqual(data);
  });

  it("rejects a different origin or window", () => {
    expect(readWebappTabSwipeMessage(
      { data, origin: "http://other-host:3100", source: frame },
      "http://192.168.0.104:3100",
      frame,
    )).toBeNull();
    expect(readWebappTabSwipeMessage(
      { data, origin: "http://192.168.0.104:3100", source: {} as Window },
      "http://192.168.0.104:3100",
      frame,
    )).toBeNull();
  });
});
