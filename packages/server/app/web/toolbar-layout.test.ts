import { describe, expect, it } from "vitest";
import { resolveToolbarLayout } from "./toolbar-layout";

const base = { toolWidths: [40, 40, 40, 40, 40, 40, 40], availableWidth: 244, fullAvailableWidth: 244, avatarWidth: 44, toggleWidth: 40, gap: 0, expanded: false };

describe("responsive toolbar space allocation", () => {
  it("shows all tools without a toggle when they exactly fit", () => {
    const layout = resolveToolbarLayout({ ...base, fullAvailableWidth: 324 });
    expect(layout).toEqual({ fullFits: true, inlineIndices: [0, 1, 2, 3, 4, 5, 6], overflowIndices: [] });
  });
  it("keeps compact tools out of the tab row until the user expands them", () => {
    expect(resolveToolbarLayout(base).inlineIndices).toEqual([]);
  });
  it("expands fitting tools inline and leaves only the remainder in the dropdown", () => {
    expect(resolveToolbarLayout({ ...base, expanded: true })).toEqual({ fullFits: false, inlineIndices: [0, 1, 2], overflowIndices: [3, 4, 5, 6] });
  });
  it("does not reserve space for an unavailable install button", () => {
    const layout = resolveToolbarLayout({ ...base, toolWidths: [40, 0, 40, 40], expanded: true });
    expect(layout.inlineIndices).toEqual([0, 2, 3]);
    expect(layout.overflowIndices).toEqual([]);
  });
  it("preserves fixed controls when no tool fits and still exposes overflow", () => {
    const layout = resolveToolbarLayout({ ...base, availableWidth: 124, fullAvailableWidth: 124, expanded: true });
    expect(layout.inlineIndices).toEqual([]);
    expect(layout.overflowIndices).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});
