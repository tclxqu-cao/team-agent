import type {
  IAgentLoop,
  AgentEvent,
  AgentConfig,
} from './entities.js';
import type { Message, ToolCall } from '../model/entities.js';
import type { ToolContext } from '../tool/entities.js';
import { ContextCompactor } from './ContextCompactor.js';

export class AgentLoop implements IAgentLoop {
  private readonly config: AgentConfig;
  private readonly compactor: ContextCompactor;
  private abortController: AbortController | null = null;

  constructor(config: AgentConfig) {
    this.config = config;
    this.compactor = new ContextCompactor(config.modelProvider);
  }

  async *run(input: string, sessionId: string): AsyncIterable<AgentEvent> {
    this.abortController = new AbortController();

    // 1. Load session history
    let history: Message[] = [];
    if (this.config.sessionStore) {
      const session = await this.config.sessionStore.get(sessionId);
      // Only include user/assistant/tool messages (not system)
      history = (session?.messages ?? []).filter(
        (m) => m.role !== "system",
      );
    }

    // 2. Assemble context
    const memoryContext = await this.config.memoryStore.generateContext(input);
    const assembled = await this.config.contextAssembler.assemble({
      rootDir: this.config.workingDirectory,
      userMessage: input,
      history,
      tools: JSON.stringify(this.config.toolRegistry.getDefinitions()),
      memoryContext,
      skillPrompts: "",
      maxTokens: this.config.maxTokens,
      systemPrompt: this.config.systemPrompt,
    });

    let messages: Message[] = [
      { role: "system", content: assembled.systemPrompt },
      ...assembled.messages,
      { role: "user", content: input },
    ];

    const compactThreshold = this.config.compactThreshold ?? 0.8;
    const tokenLimit = this.config.maxTokens;

    let currentText = "";
    let iteration = 0;

    // 3. ReAct Loop
    while (iteration < this.config.maxIterations) {
      if (this.abortController.signal.aborted) {
        yield { type: "done", finalText: currentText || "Aborted" };
        return;
      }

      iteration++;
      yield { type: "thinking", message: `Iteration ${iteration}...` };

      // ── Context management ──────────────────────────────────────────
      // Step A: lightweight prune of old tool results
      messages = this.compactor.pruneToolResults(messages);

      // Step B: token check → AutoCompact if over threshold
      const tokenCount = await this.compactor.estimateTokens(messages);
      if (tokenCount > tokenLimit * compactThreshold) {
        yield { type: "thinking", message: "Context approaching limit — compacting…" };
        const result = await this.compactor.compact(messages);
        messages = result.messages;
        if (result.removedMessages > 0) {
          yield {
            type: "compacted",
            summary: result.summary,
            removedMessages: result.removedMessages,
          };
        }
      }
      // ───────────────────────────────────────────────────────────────

      const toolDefs = this.config.toolRegistry.getDefinitions();
      const toolCalls: ToolCall[] = [];
      let hasError = false;

      try {
        for await (const event of this.config.modelProvider.streamChat(messages, {
          tools: toolDefs.length > 0 ? toolDefs : undefined,
          maxTokens: this.config.maxTokens,
        })) {
          if (this.abortController?.signal.aborted) break;

          switch (event.type) {
            case "text_chunk":
              currentText += event.text;
              yield { type: "text_chunk", text: event.text };
              break;
            case "tool_call":
              toolCalls.push(event.toolCall);
              yield { type: "tool_call", toolCall: event.toolCall };
              break;
            case "text_done":
              yield { type: "text_done" };
              break;
            case "error":
              hasError = true;
              yield { type: "error", message: event.message };
              break;
          }
        }
      } catch (err) {
        yield {
          type: "error",
          message: err instanceof Error ? err.message : "Model call failed",
        };
        hasError = true;
      }

      // If no tool calls, we're done
      if (toolCalls.length === 0 || hasError) {
        yield { type: "done", finalText: currentText };
        return;
      }

      // 4. Add assistant message with tool calls
      const assistantMsg: Message = {
        role: "assistant",
        content: currentText,
        toolCalls,
      };
      messages.push(assistantMsg);

      // 5. Execute each tool call and observe
      for (const tc of toolCalls) {
        const ctx: ToolContext = {
          workingDirectory: this.config.workingDirectory,
          sessionId,
          signal: this.abortController.signal,
        };

        const result = await this.config.toolExecutor.execute(
          tc.name,
          tc.arguments,
          ctx,
        );

        result.toolCallId = tc.id;
        yield { type: "tool_result", result };

        // 6. Add tool result to messages
        messages.push({
          role: "tool",
          content: result.content,
          toolCallId: tc.id,
          name: tc.name,
        });
      }

      // Reset text for next iteration
      currentText = "";
    }

    yield {
      type: "done",
      finalText: currentText || `Reached max iterations (${this.config.maxIterations})`,
    };
  }

  abort(): void {
    this.abortController?.abort();
  }
}

