import { describe, it, expect } from "vitest";
import { ToolRegistry } from '../ToolRegistry.js';
import { ReadFileTool } from '../builtin/ReadFileTool.js';
import { WriteFileTool } from '../builtin/WriteFileTool.js';
import { BashTool } from '../builtin/BashTool.js';
import { WebFetchTool } from '../builtin/WebFetchTool.js';
import { WebSearchTool } from '../builtin/WebSearchTool.js';

describe("ToolRegistry", () => {
  it("should register and retrieve a tool", () => {
    const registry = new ToolRegistry();
    const tool = new ReadFileTool();
    registry.register(tool);

    expect(registry.get("read_file")).toBe(tool);
    expect(registry.getAll()).toHaveLength(1);
  });

  it("should unregister a tool", () => {
    const registry = new ToolRegistry();
    registry.register(new ReadFileTool());
    registry.unregister("read_file");
    expect(registry.get("read_file")).toBeUndefined();
  });

  it("should return tool definitions", () => {
    const registry = new ToolRegistry();
    registry.register(new BashTool());
    const defs = registry.getDefinitions();

    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe("bash");
    expect(defs[0].parameters).toHaveProperty("type", "object");
  });

  it("should validate tool parameters", () => {
    const registry = new ToolRegistry();
    registry.register(new ReadFileTool());

    expect(registry.validate("read_file", { file_path: "/test.txt" })).toBe(true);
    expect(registry.validate("read_file", {})).toBe(false);
    expect(registry.validate("nonexistent", {})).toBe(false);
  });

  it("should execute a tool with valid params", async () => {
    const registry = new ToolRegistry();
    registry.register(new WriteFileTool());

    const result = await registry.execute("write_file", {
      file_path: "/tmp/test-output.txt",
      content: "hello",
    }, { workingDirectory: "/tmp", sessionId: "test" });

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("File written");
  });

  it("should return error for unknown tool", async () => {
    const registry = new ToolRegistry();
    const result = await registry.execute("unknown", {}, {
      workingDirectory: "/tmp",
      sessionId: "test",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Unknown tool");
  });

  it("all builtin tools should register without error", () => {
    const registry = new ToolRegistry();
    registry.register(new ReadFileTool());
    registry.register(new WriteFileTool());
    registry.register(new BashTool());
    registry.register(new WebFetchTool());
    registry.register(new WebSearchTool());

    expect(registry.getAll()).toHaveLength(5);
  });
});
