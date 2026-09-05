import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  QueryNavigationRail,
  queryIndexFromPointer,
  queryKeyboardIndex,
  queryTickIndices,
} from "./QueryNavigationRail";

describe("QueryNavigationRail helpers", () => {
  it("maps the full pointer range to every query ordinal", () => {
    expect(queryIndexFromPointer(100, 100, 200, 101)).toBe(0);
    expect(queryIndexFromPointer(200, 100, 200, 101)).toBe(50);
    expect(queryIndexFromPointer(300, 100, 200, 101)).toBe(100);
  });

  it("bounds visual ticks at sixty while preserving both endpoints", () => {
    const ticks = queryTickIndices(1_000);
    expect(ticks).toHaveLength(60);
    expect(ticks[0]).toBe(0);
    expect(ticks.at(-1)).toBe(999);
  });

  it("supports discrete slider keyboard movement", () => {
    expect(queryKeyboardIndex(5, "ArrowUp", 20)).toBe(4);
    expect(queryKeyboardIndex(5, "PageDown", 20)).toBe(10);
    expect(queryKeyboardIndex(5, "Home", 20)).toBe(0);
    expect(queryKeyboardIndex(5, "End", 20)).toBe(19);
  });

  it("announces and renders loading for the selected cross-page query", () => {
    const entries = [
      { messageId: "q1", ordinal: 1, preview: "first", pageToken: "a1" },
      { messageId: "q2", ordinal: 2, preview: "second", pageToken: "a2" },
    ];
    const html = renderToStaticMarkup(
      <QueryNavigationRail
        entries={entries}
        activeMessageId="q2"
        loadingMessageId="q2"
        onActivate={() => undefined}
      />,
    );

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-label="正在定位消息"');
    expect(html).toContain('query-navigation-rail__loading');
  });
});
