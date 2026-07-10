import { describe, expect, it } from "vitest";
import type { SystemPromptSections } from '../../context/entities.js';
import type { Message, ToolDefinition } from '../../model/entities.js';
import {
  COMPACTION_ACKNOWLEDGEMENT,
  COMPACTION_SUMMARY_PREFIX,
} from '../ContextCompactor.js';
import { estimateContextUsage } from '../ContextUsageEstimator.js';

const systemSections: SystemPromptSections = {
  systemBase: "base prompt",
  environment: "environment details",
  projectContext: "project context",
  skills: "skill prompt",
  memory: "memory context",
  embeddedTools: "embedded tool json",
};

const nativeToolDefinitions: ToolDefinition[] = [{
  name: "read_file",
  description: "Read a file",
  parameters: { type: "object", properties: { path: { type: "string" } } },
}];

function segmentTokens(
  snapshot: ReturnType<typeof estimateContextUsage>,
  category: typeof snapshot.segments[number]["category"],
): number {
  return snapshot.segments.find((segment) => segment.category === category)?.tokens ?? 0;
}

describe("estimateContextUsage", () => {
  it("accounts for every system section, native tools, current input, and images", () => {
    const currentUserMessage: Message = {
      role: "user",
      content: "current request",
      images: ["data:image/png;base64,abc"],
    };
    const messages: Message[] = [
      { role: "system", content: Object.values(systemSections).join("\n\n") },
      currentUserMessage,
    ];

    const snapshot = estimateContextUsage({
      requestIndex: 1,
      providerId: "anthropic",
      modelId: "claude-test",
      maxTokens: 100_000,
      messages,
      currentUserMessage,
      nativeToolDefinitions,
      systemSections,
    });

    for (const category of [
      "systemBase",
      "environment",
      "projectContext",
      "skills",
      "memory",
      "embeddedTools",
      "currentUserMessage",
      "images",
      "nativeToolDefinitions",
      "messageOverhead",
    ] as const) {
      expect(segmentTokens(snapshot, category)).toBeGreaterThan(0);
    }
    expect(snapshot.totalTokens).toBe(
      snapshot.segments.reduce((sum, segment) => sum + segment.tokens, 0),
    );
    expect(snapshot.ratio).toBe(snapshot.totalTokens / snapshot.maxTokens);
  });

  it("separates history, assistant text, tool calls, and tool results", () => {
    const currentUserMessage: Message = { role: "user", content: "same text" };
    const messages: Message[] = [
      { role: "system", content: "base prompt" },
      { role: "user", content: "same text" },
      {
        role: "assistant",
        content: "I will read it",
        toolCalls: [{ id: "tc1", name: "read_file", arguments: { path: "a.ts" } }],
      },
      { role: "tool", content: "file contents", name: "read_file", toolCallId: "tc1" },
      currentUserMessage,
    ];

    const snapshot = estimateContextUsage({
      requestIndex: 2,
      providerId: "openai",
      modelId: "gpt-test",
      maxTokens: 100_000,
      messages,
      currentUserMessage,
      nativeToolDefinitions: [],
      systemSections: { ...systemSections, environment: "", projectContext: "", skills: "", memory: "", embeddedTools: "" },
    });

    expect(segmentTokens(snapshot, "conversationHistory")).toBeGreaterThan(0);
    expect(segmentTokens(snapshot, "currentUserMessage")).toBeGreaterThan(0);
    expect(segmentTokens(snapshot, "assistantMessages")).toBeGreaterThan(0);
    expect(segmentTokens(snapshot, "toolCalls")).toBeGreaterThan(0);
    expect(segmentTokens(snapshot, "toolResults")).toBeGreaterThan(0);
  });

  it("attributes the compaction pair without mixing it into history or assistant text", () => {
    const currentUserMessage: Message = { role: "user", content: "continue" };
    const messages: Message[] = [
      { role: "system", content: "base prompt" },
      { role: "user", content: `${COMPACTION_SUMMARY_PREFIX}\nSummary body` },
      { role: "assistant", content: COMPACTION_ACKNOWLEDGEMENT },
      currentUserMessage,
    ];

    const snapshot = estimateContextUsage({
      requestIndex: 1,
      providerId: "deepseek",
      modelId: "deepseek-test",
      maxTokens: 1000,
      messages,
      currentUserMessage,
      nativeToolDefinitions: [],
      systemSections: { ...systemSections, environment: "", projectContext: "", skills: "", memory: "", embeddedTools: "" },
    });

    expect(segmentTokens(snapshot, "compactionSummary")).toBeGreaterThan(0);
    expect(segmentTokens(snapshot, "conversationHistory")).toBe(0);
    expect(segmentTokens(snapshot, "assistantMessages")).toBe(0);
    expect(segmentTokens(snapshot, "currentUserMessage")).toBeGreaterThan(0);
  });
});
