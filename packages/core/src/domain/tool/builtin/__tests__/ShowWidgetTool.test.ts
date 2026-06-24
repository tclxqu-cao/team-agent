import { describe, it, expect } from "vitest";
import { ShowWidgetTool } from "../ShowWidgetTool.js";

describe("ShowWidgetTool", () => {
  const tool = new ShowWidgetTool();

  it("should have correct name and description", () => {
    expect(tool.name).toBe("show_widget");
    expect(tool.description).toContain("custom UI card");
  });

  it("should return widgetId on execute", async () => {
    const result = await tool.execute(
      { widget_type: "storyboard_workbench", data: { shots: [] } },
      { workingDirectory: "/tmp", sessionId: "s1" } as any,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("widgetId");
  });

  it("should accept update_id to update existing widget", async () => {
    const result = await tool.execute(
      { widget_type: "storyboard_workbench", data: { shots: [1] }, update_id: "w-123" },
      { workingDirectory: "/tmp", sessionId: "s1" } as any,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("w-123");
  });

  it("should reject missing widget_type", async () => {
    const result = await tool.execute(
      { data: {} },
      { workingDirectory: "/tmp", sessionId: "s1" } as any,
    );
    expect(result.isError).toBe(true);
  });
});
