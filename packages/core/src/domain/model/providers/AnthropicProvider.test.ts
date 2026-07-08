import { describe, it, expect, vi, afterEach } from "vitest";
import { AnthropicProvider } from './AnthropicProvider.js';
import { AskUserTool } from '../../tool/builtin/AskUserTool.js';

function streamResponse(): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"type":"message_stop"}\n\n'));
      controller.close();
    },
  }), { status: 200 });
}

describe("AnthropicProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes complete tool schemas as Anthropic input_schema", async () => {
    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      requestBody = JSON.parse(String((init as RequestInit).body));
      return streamResponse();
    }));

    const provider = new AnthropicProvider({ apiKey: "test-key", modelId: "claude-test" });
    const askUser = new AskUserTool(async () => ({ answer: "ok" }));

    for await (const _event of provider.streamChat(
      [{ role: "user", content: "Need a choice" }],
      { tools: [{ name: askUser.name, description: askUser.description, parameters: askUser.parameters }] },
    )) {
      // drain stream
    }

    const tools = requestBody?.tools as Array<{ name: string; input_schema: Record<string, unknown> }>;
    const askUserSchema = tools.find((tool) => tool.name === "ask_user")?.input_schema;

    expect(askUserSchema).toEqual(askUser.parameters);
    expect(askUserSchema?.required).toEqual(["question"]);
    expect((askUserSchema?.properties as Record<string, unknown>)).toHaveProperty("question");
  });
});
