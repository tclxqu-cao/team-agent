import { describe, it, expect } from "vitest";
import { AgentBuilder } from './AgentBuilder.js';
import type { IModelProvider, StreamEvent } from '../model/entities.js';

function createModel(): IModelProvider {
  return {
    providerId: "mock",
    modelId: "mock-model",
    streamChat: async function* (): AsyncIterable<StreamEvent> {
      yield { type: "text_chunk", text: "done" };
      yield { type: "text_done" };
    },
    countTokens: async () => 10,
    supportsModel: () => true,
  };
}

describe("AgentBuilder", () => {
  it("keeps getToolRegistry pointed at the registry created for buildSync", () => {
    const builder = new AgentBuilder()
      .withWorkingDirectory(process.cwd())
      .withModelProvider(createModel());

    const beforeBuild = builder.getToolRegistry();
    builder.buildSync();
    const afterBuild = builder.getToolRegistry();

    expect(afterBuild).not.toBe(beforeBuild);
    expect(afterBuild.getDefinitions().some((tool) => tool.name === "read_file")).toBe(true);
  });
});
