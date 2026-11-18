import { describe, expect, it } from "vitest";
import { equalTaskLayout, ownsTaskPaneEvent, readTaskLayout, removeTaskPane, resizeTaskSplit, swapTaskPanes, taskPaneIds, taskSplitGeometry, taskSplitPointerRatio } from "./desktop-task-layout";

describe("desktop task pane geometry", () => {
  it("swaps complete panes while preserving split ratios, stable identities and saved order", () => {
    const original = resizeTaskSplit(equalTaskLayout(["a", "b", "c", "d"])!, "split:a|b|c|d", .65);
    const swapped = swapTaskPanes(original, "a", "d");
    expect(taskPaneIds(swapped)).toEqual(["d", "b", "c", "a"]);
    expect(swapped.kind === "split" && swapped.ratio).toBe(.65);
    expect(readTaskLayout(swapped, ["a", "b", "c", "d"])).toEqual(swapped);
    expect(swapTaskPanes(original, "a", "missing")).toBe(original);
    expect(swapTaskPanes(original, "a", "a")).toBe(original);
    expect(swapTaskPanes(swapped, "a", "d")).toEqual(original);
  });

  it("lays out stable sibling panes with exactly one pixel between them", () => {
    const tree = equalTaskLayout(["a", "b", "c", "d"])!;
    const layout = taskSplitGeometry(tree, 1001, 601);
    expect(layout.panes.map(item => [item.paneId, item.rect])).toEqual([
      ["a", { x: 0, y: 0, width: 500, height: 300 }],
      ["b", { x: 0, y: 301, width: 500, height: 300 }],
      ["c", { x: 501, y: 0, width: 500, height: 300 }],
      ["d", { x: 501, y: 301, width: 500, height: 300 }],
    ]);
    expect(layout.separators).toHaveLength(3);
    const swapped = taskSplitGeometry(swapTaskPanes(tree, "a", "d"), 1001, 601);
    expect(swapped.panes.find(pane => pane.paneId === "a")?.rect).toEqual(layout.panes.find(pane => pane.paneId === "d")?.rect);
  });

  it("gives every initial task equal area, including odd task counts", () => {
    for (const ids of [["a", "b", "c"], ["a", "b", "c", "d"], Array.from({ length: 9 }, (_, i) => String(i))]) {
      const tree = equalTaskLayout(ids)!;
      const areas: number[] = [];
      const visit = (node: typeof tree, area = 1) => {
        if (node.kind === "pane") areas.push(area);
        else { visit(node.first, area * node.ratio); visit(node.second, area * (1 - node.ratio)); }
      };
      visit(tree);
      expect(taskPaneIds(tree)).toEqual(ids);
      for (const area of areas) expect(area).toBeCloseTo(1 / ids.length);
    }
  });

  it("changes one divider without changing task identities or the other branch", () => {
    const tree = equalTaskLayout(["a", "b", "c", "d"])!;
    if (tree.kind !== "split" || tree.first.kind !== "split") throw new Error("Expected a split");
    const changed = resizeTaskSplit(tree, tree.first.id, 0.7);
    expect(changed.kind === "split" && changed.second).toBe(tree.second);
    expect(taskPaneIds(changed)).toEqual(["a", "b", "c", "d"]);
    expect(readTaskLayout(changed, ["a", "b", "c", "d"])).toEqual(changed);
    expect(taskSplitPointerRatio(0.5, 100, 1000)).toBeCloseTo(0.6);
    expect(taskSplitPointerRatio(0.5, -1000, 400)).toBe(0.25);
    expect(taskSplitPointerRatio(0.6, 20, 0)).toBe(0.6);
  });

  it("removes a view and collapses its empty branch while preserving the remaining proportions", () => {
    const tree = equalTaskLayout(["a", "b", "c", "d"])!;
    if (tree.kind !== "split") throw new Error("Expected a split");
    const resized = resizeTaskSplit(tree, tree.id, 0.65);
    const closed = removeTaskPane(resized, "a")!;
    expect(taskPaneIds(closed)).toEqual(["b", "c", "d"]);
    expect(closed.kind === "split" && closed.ratio).toBe(0.65);
    expect(removeTaskPane(closed, "missing")).toBe(closed);
    expect(removeTaskPane({ kind: "pane", paneId: "a" }, "a")).toBeNull();
  });

  it("rejects corrupt persisted layouts rather than duplicating or losing a task", () => {
    const tree = equalTaskLayout(["a", "b"])!;
    expect(readTaskLayout(tree, ["a", "b"])).toEqual(tree);
    expect(readTaskLayout(tree, ["a", "missing"])).toBeNull();
    expect(readTaskLayout({ ...tree, ratio: NaN }, ["a", "b"])).toBeNull();
    expect(readTaskLayout({ ...tree, second: { kind: "pane", paneId: "a" } }, ["a", "b"])).toBeNull();
    expect(readTaskLayout({}, ["a"])).toBeNull();
  });
});

describe("desktop pane stream ownership", () => {
  it("accepts its own and explicitly managed background run without reacting to another pane", () => {
    const managed = new Set(["old-task"]);
    expect(ownsTaskPaneEvent("current", "current", managed)).toBe(true);
    expect(ownsTaskPaneEvent("old-task", "current", managed)).toBe(true);
    expect(ownsTaskPaneEvent("other-pane", "current", managed)).toBe(false);
    expect(ownsTaskPaneEvent(undefined, "current", managed)).toBe(true);
  });
});
