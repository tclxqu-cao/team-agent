import { describe, expect, it } from "vitest";
import { migrateTaskPanelPreferences, readTaskPanelPreferences, taskPanelPixels, taskPanelPosition } from "./session-task-panel-state";

describe("session task panel placement", () => {
  const bounds = { width: 1000, height: 800, panelWidth: 300, panelHeight: 200 };

  it("keeps a dragged panel inside its own pane at every edge", () => {
    expect(taskPanelPosition({ x: -300, y: -100 }, bounds)).toEqual({ x: 0, y: 0 });
    const bottomRight = taskPanelPosition({ x: 1500, y: 1200 }, bounds);
    expect(bottomRight).toEqual({ x: 1, y: 1 });
    expect(taskPanelPixels(bottomRight, bounds)).toEqual({ x: 692, y: 592 });
  });

  it("preserves relative placement when a split pane narrows or the card expands", () => {
    const position = taskPanelPosition({ x: 350, y: 300 }, bounds);
    const narrow = { width: 320, height: 420, panelWidth: 296, panelHeight: 350 };
    const pixels = taskPanelPixels(position, narrow);
    expect(pixels.x).toBeGreaterThanOrEqual(8);
    expect(pixels.x + narrow.panelWidth).toBeLessThanOrEqual(312);
    expect(pixels.y + narrow.panelHeight).toBeLessThanOrEqual(412);
    expect(taskPanelPosition({ x: 100, y: 100 }, { width: 300, height: 200, panelWidth: 300, panelHeight: 200 })).toEqual({ x: 0, y: 0 });
  });

  it("restores hidden state and ignores invalid saved coordinates", () => {
    expect(readTaskPanelPreferences(null)).toEqual({ visible: false, position: null });
    expect(readTaskPanelPreferences({ visible: false, position: { x: .3, y: .7 } }))
      .toEqual({ visible: false, position: { x: .3, y: .7 } });
    expect(readTaskPanelPreferences({ visible: false, position: { x: NaN, y: 1 } })).toEqual({ visible: false, position: null });
    expect(readTaskPanelPreferences({ visible: "false", position: { x: -1, y: 3 } })).toEqual({ visible: false, position: { x: 0, y: 1 } });
  });

  it("migrates old implicit visibility while preserving placement and new manual choices", () => {
    expect(migrateTaskPanelPreferences({ visible: true, position: { x: .3, y: .7 } }))
      .toEqual({ visible: false, position: { x: .3, y: .7 } });
    expect(readTaskPanelPreferences({ visible: true, position: null })).toEqual({ visible: true, position: null });
  });
});
