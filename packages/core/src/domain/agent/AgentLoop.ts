import type {
  IAgentLoop,
  AgentEvent,
  AgentConfig,
} from './entities.js';
import type { Message, ToolCall } from '../model/entities.js';
import type { ToolContext } from '../tool/entities.js';
import {
  COMPACTION_ACKNOWLEDGEMENT,
  COMPACTION_SUMMARY_PREFIX,
  ContextCompactor,
} from './ContextCompactor.js';
import { estimateContextUsage } from './ContextUsageEstimator.js';

export class AgentLoop implements IAgentLoop {
  private readonly config: AgentConfig;
  private readonly compactor: ContextCompactor;
  private abortController: AbortController | null = null;
  /** Names of tools registered at construction time. Tools added AFTER construction
   *  (session tools, MCP tools) are always visible to the LLM regardless of enabledTools. */
  private readonly initialToolNames: Set<string>;

  constructor(config: AgentConfig) {
    this.config = config;
    this.compactor = new ContextCompactor(config.modelProvider);
    this.initialToolNames = new Set(config.toolRegistry.getAll().map((t) => t.name));
  }

  /**
   * Remove orphaned assistant tool_calls messages and their partial tool responses
   * from session history. This prevents "insufficient tool messages following
   * tool_calls message" errors from the model API.
   */
  private sanitizeHistory(messages: Message[]): Message[] {
    // Collect all tool response toolCallIds
    const respondedIds = new Set<string>();
    for (const m of messages) {
      if (m.role === "tool" && m.toolCallId) {
        respondedIds.add(m.toolCallId);
      }
    }

    // Find assistant messages with toolCalls where not all calls have responses
    const orphanedIds = new Set<string>();
    for (const m of messages) {
      if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
        const allResponded = m.toolCalls.every((tc) => respondedIds.has(tc.id));
        if (!allResponded) {
          for (const tc of m.toolCalls) {
            orphanedIds.add(tc.id);
          }
        }
      }
    }

    if (orphanedIds.size === 0) return messages;

    // Remove orphaned assistant messages and their partial tool responses
    return messages.filter((m) => {
      if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
        return m.toolCalls.every((tc) => !orphanedIds.has(tc.id));
      }
      if (m.role === "tool" && m.toolCallId) {
        return !orphanedIds.has(m.toolCallId);
      }
      return true;
    });
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
            { role: "user", content: `${COMPACTION_SUMMARY_PREFIX}\n${cp.summary}` },
            { role: "assistant", content: COMPACTION_ACKNOWLEDGEMENT },
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

    // Sanitize history: remove orphaned tool_calls without matching tool responses
    history = this.sanitizeHistory(history);

    // 2. Assemble context
    const memoryContext = await this.config.memoryStore.generateContext(input);
    const assembled = await this.config.contextAssembler.assemble({
      rootDir: this.config.workingDirectory,
      userMessage: input,
      history,
      tools: JSON.stringify(this.getFilteredToolDefinitions()),
      memoryContext,
      skillPrompts: await this.config.skillRegistry.getSkillPrompts(input, this.config.enabledSkills),
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
    let currentUserMessage: Message;
    if (userMsgAlreadyInHistory) {
      // Replace the last (user) message with one that includes images if provided.
      currentUserMessage = images && images.length > 0
        ? { ...assembled.messages.at(-1)!, images }
        : assembled.messages.at(-1)!;
      messages = [
        { role: "system", content: assembled.systemPrompt },
        ...assembled.messages.slice(0, -1),
        currentUserMessage,
      ];
    } else {
      currentUserMessage = userMsgWithImages;
      messages = [
        { role: "system", content: assembled.systemPrompt },
        ...assembled.messages,
        currentUserMessage,
      ];
    }

    const compactThreshold = this.config.compactThreshold ?? 0.6;
    const tokenLimit = this.config.maxTokens;

    let currentText = "";
    let iteration = 0;
    // Track total session messages so we can pick up externally-added ones mid-loop
    let msgCheckpoint = (await this.config.sessionStore?.get(sessionId))?.messages?.length ?? 0;

    // 3. ReAct Loop
    while (iteration < this.config.maxIterations) {
      if (this.abortController.signal.aborted) {
        yield { type: "turn_aborted" };
        yield { type: "done", finalText: currentText || "Aborted" };
        return;
      }

      iteration++;
      yield { type: "thinking", message: `Iteration ${iteration}...` };

      // ── Steer / Mailbox check: inject new session messages ──
      // Picks up messages added externally (steer or sub-agent completion) while loop runs.
      if (this.config.sessionStore) {
        try {
          const session = await this.config.sessionStore.get(sessionId);
          const totalCount = session?.messages?.length ?? 0;
          if (totalCount > msgCheckpoint) {
            const newMsgs = session!.messages.slice(msgCheckpoint);
            msgCheckpoint = totalCount;
            for (const m of newMsgs) {
              if (m.name === "__steer__" || m.name === "__mailbox__") {
                messages.push(m);
              }
            }
          }
        } catch {
          // Non-critical — ignore
        }
      }
      // ───────────────────────────────────────────────────────────────────────

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

      const toolDefs = this.getFilteredToolDefinitions();
      yield {
        type: "context_usage",
        usage: estimateContextUsage({
          requestIndex: iteration,
          providerId: this.config.modelProvider.providerId,
          modelId: this.config.modelProvider.modelId,
          maxTokens: tokenLimit,
          messages,
          currentUserMessage,
          nativeToolDefinitions: toolDefs,
          systemSections: assembled.systemSections,
        }),
      };
      const toolCalls: ToolCall[] = [];
      let hasError = false;
      const maxRetries = this.config.streamMaxRetries ?? 0;

      // Retry transient transport failures and one stream that ends without any output.
      // Model-level errors and partial responses are not retried because doing so
      // could duplicate text or tool calls that have already reached the caller.
      let networkRetries = 0;
      let emptyStreamRetries = 0;
      let totalRetries = 0;
      const waitForRetry = (delay: number): Promise<boolean> => new Promise((resolve) => {
        if (this.abortController?.signal.aborted) {
          resolve(false);
          return;
        }
        const timer = setTimeout(() => {
          this.abortController?.signal.removeEventListener("abort", onAbort);
          resolve(true);
        }, delay);
        const onAbort = () => {
          clearTimeout(timer);
          resolve(false);
        };
        this.abortController?.signal.addEventListener("abort", onAbort, { once: true });
      });

      while (true) {
        if (totalRetries > 0) {
          yield { type: "thinking", message: `Retrying (${totalRetries})…` };
          // Exponential backoff: 1s, 2s, 4s, … capped at 10s
          const delay = Math.min(1000 * Math.pow(2, totalRetries - 1) + Math.random() * 500, 10_000);
          if (!(await waitForRetry(delay))) {
            yield { type: "turn_aborted" };
            return;
          }
        }

        let streamHadError = false;
        let streamProducedOutput = false;
        let streamEnded = false;
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
                streamProducedOutput = streamProducedOutput || event.text.length > 0;
                currentText += event.text;
                yield { type: "text_chunk", text: event.text };
                break;
              case "tool_call":
                streamProducedOutput = true;
                toolCalls.push(event.toolCall);
                yield { type: "tool_call", toolCall: event.toolCall };
                break;
              case "text_done":
                streamEnded = true;
                break;
              case "error":
                streamProducedOutput = true;
                streamHadError = true;
                hasError = true;
                yield { type: "error", message: event.message, code: "strea-err" };
                break;
            }
          }
          if (!streamProducedOutput && !this.abortController?.signal.aborted) {
            if (emptyStreamRetries === 0) {
              emptyStreamRetries++;
              totalRetries++;
              continue;
            }
            hasError = true;
            yield { type: "error", message: "Model stream ended without producing a response after retry" };
          }
          if (streamHadError || hasError) break; // model-level error, not retryable
          if (streamEnded) yield { type: "text_done" };
          break; // success — exit retry loop
        } catch (err) {
          if (this.abortController?.signal.aborted) {
            yield { type: "turn_aborted" };
            return;
          }
          const msg = err instanceof Error ? err.message : String(err);
          const isRetryable = /timeout|rate\s*limit|5\d{2}|econnrefused|econnreset|network|temporary|too many|retry/i.test(msg);
          if (streamProducedOutput || !isRetryable || networkRetries >= maxRetries) {
            yield { type: "error", message: msg };
            hasError = true;
            break;
          }
          networkRetries++;
          totalRetries++;
        }
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

      // 5. Execute all tool calls in parallel with abort support
      // Each tool is raced against the abort signal so cancellation is instant.
      // Uses Promise.allSettled so one tool failure doesn't abort the entire turn
      // — the model can see individual tool errors and decide what to do.
      const toolResults: Array<import("../tool/entities.js").ToolResult> = [];
      const settled = await Promise.allSettled(
        toolCalls.map(async (tc) => {
          const ctx: ToolContext = {
            workingDirectory: this.config.workingDirectory,
            sessionId,
            signal: this.abortController!.signal,
          };
          const result = await Promise.race([
            this.config.toolExecutor.execute(tc.name, tc.arguments, ctx),
            new Promise<never>((_, reject) => {
              if (this.abortController!.signal.aborted) {
                reject(new Error("turn_aborted"));
                return;
              }
              this.abortController!.signal.addEventListener(
                "abort",
                () => reject(new Error("turn_aborted")),
                { once: true },
              );
            }),
          ]);
          result.toolCallId = tc.id;
          return result;
        }),
      );

      let wasAborted = false;
      for (let i = 0; i < settled.length; i++) {
        const s = settled[i];
        const tc = toolCalls[i];
        let result: import("../tool/entities.js").ToolResult;
        if (s.status === "fulfilled") {
          result = s.value;
        } else {
          // Individual tool failure — record error result instead of aborting
          const errMsg = s.reason?.message === "turn_aborted" ? "turn_aborted" : (s.reason?.message ?? "Tool execution failed");
          if (errMsg === "turn_aborted") {
            wasAborted = true;
            break;
          }
          result = { toolCallId: tc.id, content: `Error: ${errMsg}`, isError: true };
        }
        toolResults.push(result);

        // If the tool result carries showWidget metadata, emit a show_widget event
        // so the frontend can render the custom UI card. The tool_result is still
        // added to messages for the LLM to see the textual result.
        const widgetMeta = (result as any).metadata?.showWidget;
        if (widgetMeta) {
          yield {
            type: "show_widget",
            widgetId: widgetMeta.widgetId,
            widgetType: widgetMeta.widgetType,
            data: widgetMeta.data,
          } as AgentEvent;
        }
        yield { type: "tool_result", result };

        // 6. Add tool result to messages
        messages.push({
          role: "tool",
          content: result.content,
          toolCallId: result.toolCallId,
          name: tc.name,
        });
      }

      if (wasAborted) {
        yield { type: "turn_aborted" };
        yield { type: "done", finalText: currentText || "Aborted" };
        return;
      }

      // ── Post-tool compaction: if tool results pushed context over limit, compact ──
      const postTokenCount = await this.compactor.estimateTokens(messages);
      if (postTokenCount > tokenLimit * compactThreshold) {
        yield { type: "thinking", message: "Context growing after tool results — compacting…" };
        const result = await this.compactor.compact(messages);
        messages = result.messages;
        if (result.removedMessages > 0) {
          yield {
            type: "compacted",
            summary: result.summary,
            removedMessages: result.removedMessages,
          };
          if (this.config.sessionStore) {
            const recentMessages = result.messages
              .filter((m) => m.role !== "system")
              .slice(2);
            await this.config.sessionStore.addMessage(sessionId, {
              role: "user",
              content: JSON.stringify({ summary: result.summary, recentMessages }),
              name: "__compaction_checkpoint__",
            }).catch(() => {});
          }
        }
      }
      // ──────────────────────────────────────────────────────────────────────────

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

  /**
   * Return tool definitions filtered by enabledTools.
   * Tools registered after construction (session tools, MCP tools) are always included.
   */
  private getFilteredToolDefinitions() {
    const all = this.config.toolRegistry.getDefinitions();
    if (!this.config.enabledTools) return all;
    const allowed = new Set(this.config.enabledTools);
    return all.filter(
      (t) => allowed.has(t.name) || !this.initialToolNames.has(t.name),
    );
  }
}

