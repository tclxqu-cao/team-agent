import { describe, expect, it } from "vitest";
import type { DesktopInputCommand } from "../desktop-input-gateway";
import { DesktopInputAdapter, screenshotPoint } from "./desktop-input-adapter";

describe("DesktopInputAdapter", () => {
  it("normalizes common key aliases", async () => {
    const commands: DesktopInputCommand[] = [];
    const adapter = new DesktopInputAdapter({ dispatch: async (command) => { commands.push(command); } });
    await adapter.keypress(["Command", "a"]);
    expect(commands).toEqual([
      { op: "key", action: "down", code: "KeyA", modifiers: ["Meta"] },
      { op: "key", action: "up", code: "KeyA", modifiers: ["Meta"] },
    ]);
  });

  it("always releases the pointer when a drag is aborted", async () => {
    const commands: DesktopInputCommand[] = [];
    const controller = new AbortController();
    const adapter = new DesktopInputAdapter({ dispatch: async (command) => {
      commands.push(command);
      if (command.op === "down") controller.abort();
    } });
    await expect(adapter.drag({ x: 1, y: 2 }, { x: 10, y: 20 }, 100, controller.signal))
      .rejects.toMatchObject({ code: "aborted" });
    expect(commands).toEqual([
      { op: "down", x: 1, y: 2, button: "left", click: 1 },
      { op: "up", x: 10, y: 20, button: "left", click: 1 },
    ]);
  });

  it("rejects coordinates outside the latest screenshot", () => {
    const frame = { data: Buffer.alloc(16), width: 100, height: 50, logicalWidth: 200, logicalHeight: 100, originX: 0, originY: 0, scaleFactor: 2, displayId: "1", quality: 90 };
    expect(() => screenshotPoint(frame, 100, 10)).toThrowError(expect.objectContaining({ code: "stale_observation" }));
  });
});
