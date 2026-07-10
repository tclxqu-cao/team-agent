import { describe, it, expect } from "vitest";
import { ContextAssembler } from '../ContextAssembler.js';
import { ContextLoader } from '../ContextLoader.js';
import type { AssembleInput } from '../entities.js';

describe("ContextAssembler", () => {
  const loader = new ContextLoader();
  const assembler = new ContextAssembler(loader);

  const baseInput: AssembleInput = {
    rootDir: "/tmp/test",
    userMessage: "Hello",
    history: [],
    tools: "[]",
    memoryContext: "",
    skillPrompts: "",
  };

  it("should assemble context with default system prompt", async () => {
    const ctx = await assembler.assemble(baseInput);

    expect(ctx.systemPrompt).toContain("expert AI assistant");
    expect(ctx.messages).toEqual([]);
    expect(ctx.tokenBudget).toBe(100_000);
    expect(ctx.tokenUsed).toBeGreaterThan(0);
  });

  it("should include memory context when provided", async () => {
    const ctx = await assembler.assemble({
      ...baseInput,
      memoryContext: "[user] Test memory content",
    });

    expect(ctx.systemPrompt).toContain("Test memory content");
  });

  it("should include skill prompts when provided", async () => {
    const ctx = await assembler.assemble({
      ...baseInput,
      skillPrompts: "## Skill: docker\nDocker expert prompt",
    });

    expect(ctx.systemPrompt).toContain("docker");
    expect(ctx.systemPrompt).toContain("Docker expert prompt");
  });

  it("should include tool definitions", async () => {
    const tools = JSON.stringify([{ name: "read_file", description: "Read a file" }]);
    const ctx = await assembler.assemble({ ...baseInput, tools });

    expect(ctx.systemPrompt).toContain("read_file");
  });

  it("should respect custom system prompt", async () => {
    const ctx = await assembler.assemble({
      ...baseInput,
      systemPrompt: "Custom system prompt here.",
    });

    expect(ctx.systemPrompt).toContain("Custom system prompt here.");
    expect(ctx.systemPrompt).not.toContain("helpful AI assistant");
  });

  it("keeps attributed sections aligned with the final system prompt", async () => {
    const ctx = await assembler.assemble({
      ...baseInput,
      systemPrompt: "Custom base",
      tools: JSON.stringify([{ name: "read_file", description: "Read a file" }]),
      skillPrompts: "## Skill: docker\nDocker expert prompt",
      memoryContext: "Remember this",
    });

    expect(ctx.systemPrompt).toBe(Object.values(ctx.systemSections).filter(Boolean).join("\n\n"));
    expect(ctx.systemSections.systemBase).toBe("Custom base");
    expect(ctx.systemSections.environment).toContain("## Environment");
    expect(ctx.systemSections.skills).toContain("Docker expert prompt");
    expect(ctx.systemSections.embeddedTools).toContain("read_file");
    expect(ctx.systemSections.memory).toContain("Remember this");
  });

  it("should truncate when over token budget", async () => {
    const bigContext = "x".repeat(500_000);

    const ctx = await assembler.assemble({
      ...baseInput,
      memoryContext: bigContext,
      maxTokens: 1000,
    });

    expect(ctx.tokenUsed).toBeLessThanOrEqual(1000);
    expect(ctx.systemPrompt).toBe(Object.values(ctx.systemSections).filter(Boolean).join("\n\n"));
  });

  it("keeps section ownership when the base prompt exceeds the final budget", async () => {
    const ctx = await assembler.assemble({
      ...baseInput,
      systemPrompt: "b".repeat(10_000),
      tools: JSON.stringify([{ name: "read_file", description: "Read a file" }]),
      maxTokens: 100,
    });

    expect(ctx.tokenUsed).toBeLessThanOrEqual(100);
    expect(ctx.systemSections.systemBase.length).toBeLessThan(400);
    expect(ctx.systemSections.environment).toBe("");
    expect(ctx.systemSections.embeddedTools).toBe("");
    expect(ctx.systemPrompt).toBe(ctx.systemSections.systemBase);
  });
});
