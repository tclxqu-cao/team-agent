import { describe, expect, it, vi } from "vitest";
import { ComputerTool } from "./computer-tool.js";
import type { ComputerRuntimePort } from "../ports/computer-runtime-port.js";

describe("ComputerTool", () => {
  it("keeps AX observations model-only and declares direct authorization", async () => {
    const runtime: ComputerRuntimePort = {
      status: async () => ({ available: true }),
      execute: vi.fn(async () => ({
        source: "accessibility",
        revision: "ax_1",
        coverage: "complete",
        app: { name: "Fixture", bundleId: "dev.fixture", pid: 1 },
        nodes: [{ id: "ax_1:1", role: "AXButton", name: "Save", actions: ["AXPress"] }],
      })),
    };
    const tool = new ComputerTool(runtime);
    const result = await tool.execute({ action: "observe" }, { sessionId: "s", workingDirectory: "/tmp" });
    expect(tool.authorization).toBe("direct");
    expect(tool.description).toContain("only when the user explicitly asks");
    expect(tool.description).toContain("task cannot continue without observing or interacting with a GUI");
    expect(tool.description).toContain("If neither condition applies, do not call this tool");
    expect(tool.description).toContain("being available is not permission or a reason to call it");
    expect(tool.description).toContain("Never call this tool speculatively");
    expect(tool.description).toContain("purpose-built tool");
    expect(JSON.parse(result.content)).toEqual({
      source: "accessibility",
      revision: "ax_1",
      coverage: "complete",
      nodeCount: 1,
    });
    expect(result.content).not.toContain("Save");
    expect(JSON.parse(result.modelContent ?? "{}")).toMatchObject({
      source: "accessibility",
      revision: "ax_1",
      nodes: [{ name: "Save" }],
    });
    expect(result.modelAttachments).toBeUndefined();
  });

  it("keeps screenshot bytes out of text and exposes a model attachment", async () => {
    const runtime: ComputerRuntimePort = {
      status: async () => ({ available: true }),
      execute: async () => ({
        source: "screenshot",
        revision: "screen_1",
        coverage: "complete",
        reason: "explicit",
        image: {
          mimeType: "image/jpeg",
          dataUrl: "data:image/jpeg;base64,YWJj",
          width: 20,
          height: 10,
          logicalWidth: 10,
          logicalHeight: 5,
          originX: 0,
          originY: 0,
        },
      }),
    };
    const result = await new ComputerTool(runtime).execute({ action: "screenshot" }, { sessionId: "s", workingDirectory: "/tmp" });
    expect(result.content).not.toContain("YWJj");
    expect(result.modelContent).toContain('"logicalWidth":10');
    expect(result.modelAttachments).toEqual([expect.objectContaining({ mimeType: "image/jpeg", dataUrl: "data:image/jpeg;base64,YWJj" })]);
  });

  it("returns structured validation errors without calling the runtime", async () => {
    const execute = vi.fn();
    const tool = new ComputerTool({ status: async () => ({ available: true }), execute });
    const result = await tool.execute({ action: "click", x: 1 }, { sessionId: "s", workingDirectory: "/tmp" });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toBe("invalid_request");
    expect(execute).not.toHaveBeenCalled();
  });

  it("preserves structured runtime errors across package or VM boundaries", async () => {
    const tool = new ComputerTool({
      status: async () => ({ available: true }),
      execute: async () => {
        throw { code: "accessibility_denied", message: "permission required", recovery: "enable it" };
      },
    });
    const result = await tool.execute({ action: "observe" }, { sessionId: "s", workingDirectory: "/tmp" });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content)).toEqual({
      error: "accessibility_denied",
      message: "permission required",
      recovery: "enable it",
    });
  });
});
