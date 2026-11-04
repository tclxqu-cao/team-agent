import type { IModelProvider, StreamEvent } from "../../entities.js";

export const openAIUsageFrames = [
  { choices: [{ delta: { content: "你好" }, finish_reason: null }], usage: null },
  { choices: [], usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14, prompt_tokens_details: { cached_tokens: 7 } } },
  { choices: [{ delta: {}, finish_reason: "stop" }] },
  { choices: [], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17, prompt_tokens_details: { cached_tokens: 7 } } },
  { choices: [], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17, prompt_tokens_details: { cached_tokens: 7 } } },
];

export const anthropicUsageFrames = [
  { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 20, cache_creation_input_tokens: 3 } } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "你好" } },
  { type: "message_delta", delta: { stop_reason: null }, usage: { output_tokens: 2 } },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 0, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  { type: "message_delta", usage: { output_tokens: 7 } },
  { type: "message_stop" },
];

/** Mock only: split UTF-8, SSE field names, JSON, and CRLF across reads. */
export function fixtureResponse(
  frames: unknown[],
  options: { chunkSize?: number; trailingNewline?: boolean; error?: Error } = {},
): Response {
  const text = frames.map((frame) => typeof frame === "string" ? frame : `data:${JSON.stringify(frame)}`).join("\r\n\r\n")
    + (options.trailingNewline === false ? "" : "\r\n\r\n");
  const bytes = new TextEncoder().encode(text);
  const chunkSize = options.chunkSize ?? Math.max(bytes.length, 1);
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset < bytes.length) {
        controller.enqueue(bytes.slice(offset, offset + chunkSize));
        offset += chunkSize;
      } else if (options.error) {
        controller.error(options.error);
      } else {
        controller.close();
      }
    },
  }));
}

export async function collectEvents(provider: IModelProvider): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of provider.streamChat([{ role: "user", content: "Hi" }])) events.push(event);
  return events;
}

export function usageEvents(events: StreamEvent[]): Extract<StreamEvent, { type: "usage" }>[] {
  return events.filter((event): event is Extract<StreamEvent, { type: "usage" }> => event.type === "usage");
}
