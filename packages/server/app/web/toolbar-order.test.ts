import { describe, expect, it } from "vitest";
import { moveToolbarAction } from "./toolbar-order";
import { validateComputerTools } from "../../../core/src/domain/web-console/computer-settings";

describe("saved toolbar order", () => {
  it("moves either direction while preserving pinned and temporarily hidden entries", () => {
    const order = ["dashboard", "refresh", "files", "remote", "theme"] as const;
    expect(moveToolbarAction(order, "theme", "dashboard")).toEqual(["theme", "dashboard", "refresh", "files", "remote"]);
    expect(moveToolbarAction(order, "dashboard", "theme")).toEqual(["refresh", "files", "remote", "theme", "dashboard"]);
    expect(order[0]).toBe("dashboard");
  });
  it("keeps a dragged order through the same validation used on save and reload", () => {
    const reordered = moveToolbarAction(["refresh", "remote", "theme", "files"], "theme", "refresh");
    expect(validateComputerTools(JSON.parse(JSON.stringify(validateComputerTools(reordered))))).toEqual(["theme", "refresh", "remote", "files"]);
  });
  it("ignores a target removed while the user was dragging", () => {
    expect(moveToolbarAction(["theme", "remote"], "theme", "refresh")).toEqual(["theme", "remote"]);
  });
});
