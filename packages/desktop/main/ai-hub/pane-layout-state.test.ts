import { describe, expect, it } from "vitest";
import { HubPaneLayoutState, type HubPaneRect } from "./pane-layout-state";

const pane = (siteId: string, x = 0): HubPaneRect => ({ siteId, x, y: 52, width: 640, height: 500 });

describe("HubPaneLayoutState", () => {
  it("retains bounds when layout arrives before a view is created", () => {
    const state = new HubPaneLayoutState();
    state.replace([pane("chatgpt")]);

    expect(state.get("chatgpt")).toEqual(pane("chatgpt"));
  });

  it("replaces existing bounds and preserves pane order", () => {
    const state = new HubPaneLayoutState();
    state.replace([pane("chatgpt")]);
    state.replace([pane("gemini"), pane("chatgpt", 640)]);

    expect(state.ids()).toEqual(["gemini", "chatgpt"]);
    expect(state.get("chatgpt")?.x).toBe(640);
  });

  it("clears retained bounds when the layout is hidden", () => {
    const state = new HubPaneLayoutState();
    state.replace([pane("grok")]);
    state.replace([]);

    expect(state.ids()).toEqual([]);
    expect(state.get("grok")).toBeUndefined();
  });

  it("does not expose mutable stored rectangles", () => {
    const state = new HubPaneLayoutState();
    const input = pane("deepseek");
    state.replace([input]);
    input.width = 1;
    const output = state.get("deepseek");
    if (output) output.height = 1;

    expect(state.get("deepseek")).toEqual(pane("deepseek"));
  });
});
