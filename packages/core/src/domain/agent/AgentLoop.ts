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

  async *run(input: string, sessionId: string, images?: string[]): AsyncIterable<AgentEvent> {
    this.abortController = new AbortController();

    // 1. Load session history
    let history: Message[] = [];
    if (this.config.sessionStore) {
      const session = await this.config.sessionStore.get(sessionId);
      const rawHistory = (session?.messages ?? []).filter((m) => m.role !== "system");

      // If a compaction checkpoint exists, restore context from it so we don't
      // re-compress on every new run. The checkpoint contains the summary text
      // and the "recent" tail messages that were kept during the last compaction.
      const lastCheckpointIdx = rawHistory.map((m) => m.name).lastIndexOf("__compaction_checkpoint__");
      if (lastCheckpointIdx >= 0) {
        try {
          const cp = JSON.parse(rawHistory[lastCheckpointIdx].content) as {
            summary: string;
            recentMessages: Message[];
          };
          history = [
            { role: "user", content: `[Context summary of earlier conversation]\n${cp.summary}` },
            { role: "assistant", content: "Understood. I have reviewed the summary and will continue from where we left off." },
            ...cp.recentMessages,
            // All messages saved AFTER the checkpoint (from subsequent runs)
            ...rawHistory.slice(lastCheckpointIdx + 1).filter((m) => m.name !== "__compaction_checkpoint__"),
          ];
        } catch {
          // Corrupt checkpoint — fall back to full history
          history = rawHistory.filter((m) => m.name !== "__compaction_checkpoint__");
        }
      } else {
        history = rawHistory.filter((m) => m.name !== "__compaction_checkpoint__");
      }
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

    // AgentHost saves the user message to the session store BEFORE calling run(),
    // so it is already present as the last entry in assembled.messages.
    // Only append it if it is not already there to avoid sending two consecutive
    // identical user messages to the LLM (which anchors the model to old context).
    const lastHistMsg = assembled.messages.at(-1);
    const userMsgAlreadyInHistory =
      lastHistMsg?.role === "user" && lastHistMsg?.content === input;

    // Attach images to the user message (current run only; not persisted to DB)
    const userMsgWithImages: Message = {
      role: "user",
      content: input,
      ...(images && images.length > 0 ? { images } : {}),
    };

    let messages: Message[];
    if (userMsgAlreadyInHistory) {
      // Replace the last (user) message with one that includes images if provided
      const base = images && images.length > 0
        ? [...assembled.messages.slice(0, -1), { ...assembled.messages.at(-1)!, images }]
        : assembled.messages;
      messages = [{ role: "system", content: assembled.systemPrompt }, ...base];
    } else {
      messages = [
        { role: "system", content: assembled.systemPrompt },
        ...assembled.messages,
        userMsgWithImages,
      ];
    }

    const compactThreshold = this.config.compactThreshold ?? 0.6;
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
          // Persist a self-contained checkpoint so the NEXT run can restore the
          // compacted context without re-compressing. Original messages are kept
          // for display; the checkpoint is hidden from the chat UI.
          if (this.config.sessionStore) {
            // recentMessages = in-memory compacted list minus system + summary pair
            const recentMessages = result.messages
              .filter((m) => m.role !== "system")
              .slice(2); // skip the summary user+assistant pair
            // Silently ignore FK errors — the session may have been deleted while running
            await this.config.sessionStore.addMessage(sessionId, {
              role: "user",
              content: JSON.stringify({ summary: result.summary, recentMessages }),
              name: "__compaction_checkpoint__",
            }).catch(() => {});
          }
        }
      }
      // ───────────────────────────────────────────────────────────────

      const toolDefs = this.config.toolRegistry.getDefinitions();
      const toolCalls: ToolCall[] = [];
      let hasError = false;

      try {
        for await (const event of this.config.modelProvider.streamChat(messages, {
          tools: toolDefs.length > 0 ? toolDefs : undefined,
          // Note: this.config.maxTokens is the context-window size used for compaction
          // thresholding, NOT the max completion tokens. Let each provider use its own
          // configured output limit (defaultMaxTokens) to avoid sending a huge value here.
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

      // 5. Execute all tool calls in parallel, then observe results
      const results = await Promise.all(
        toolCalls.map(async (tc) => {
          const ctx: ToolContext = {
            workingDirectory: this.config.workingDirectory,
            sessionId,
            signal: this.abortController!.signal,
          };
          const result = await this.config.toolExecutor.execute(
            tc.name,
            tc.arguments,
            ctx,
          );
          result.toolCallId = tc.id;
          return result;
        }),
      );

      for (const result of results) {
        yield { type: "tool_result", result };

        // 6. Add tool result to messages
        messages.push({
          role: "tool",
          content: result.content,
          toolCallId: result.toolCallId,
          name: toolCalls.find((tc) => tc.id === result.toolCallId)?.name,
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

