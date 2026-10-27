import { describe, expect, it } from "vitest";
import { DEFAULT_NAVIGATION_LAYOUT, NAVIGATION_LAYOUT_MESSAGE, isNavigationLayout, nextNavigationLayout, readNavigationLayoutMessage } from "./navigation-layout";

describe("navigation layout", () => {
  it("defaults to the single header and switches back to the original layout", () => {
    expect(DEFAULT_NAVIGATION_LAYOUT).toBe("agent-rail");
    expect(nextNavigationLayout("agent-rail")).toBe("classic");
    expect(nextNavigationLayout("classic")).toBe("agent-rail");
  });

  it.each(["classic", "agent-rail"] as const)("validates and decodes %s", navigationLayout => {
    expect(isNavigationLayout(navigationLayout)).toBe(true);
    expect(readNavigationLayoutMessage({ type: NAVIGATION_LAYOUT_MESSAGE, navigationLayout })).toBe(navigationLayout);
  });

  it.each([null, [], {}, "classic", { type: "other", navigationLayout: "classic" }, { type: NAVIGATION_LAYOUT_MESSAGE, navigationLayout: "glass" }, { type: NAVIGATION_LAYOUT_MESSAGE, navigationLayout: "compact" }])("rejects unrelated messages %j", value => {
    expect(readNavigationLayoutMessage(value)).toBeNull();
  });
});
