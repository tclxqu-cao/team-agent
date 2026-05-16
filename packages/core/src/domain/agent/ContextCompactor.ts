import type { Message } from '../model/entities.js';
import type { IModelProvider } from '../model/entities.js';

const COMPACT_PROMPT = `You are a context summarizer. Below is a conversation history between a user and an AI assistant.
Produce a concise summary that preserves:
- All decisions made and their rationale
- Key facts, code snippets, file paths, and values that were discovered or produced
- Any open tasks or pending actions
- The current state of the work

Output ONLY the summary text, no meta-commentary.`;

const TOOL_RESULT_TRUNCATE = 500; // chars to keep per tool result

export interface CompactResult {
  /** Compacted message list: [system, summary-user, summary-assistant, ...recentMessages] */
  messages: Message[];
  summary: string;
  removedMessages: number;
}

export class ContextCompactor {
  constructor(private readonly modelProvider: IModelProvider) {}

  /**
   * Step 1 (lightweight): Strip verbose tool results from old messages.
   * Keeps the last `keepRecent` tool-result messages intact.
   */
  pruneToolResults(messages: Message[], keepRecent = 6): Message[] {
    const toolResultIndices: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === "tool") toolResultIndices.push(i);
    }

    const keepSet = new Set(toolResultIndices.slice(-keepRecent));

    return messages.map((msg, i) => {
      if (msg.role === "tool" && !keepSet.has(i) && msg.content.length > TOOL_RESULT_TRUNCATE) {
        return {
          ...msg,
          content: msg.content.slice(0, TOOL_RESULT_TRUNCATE) + "\n…[truncated]",
        };
      }
      return msg;
    });
  }

  /**
   * Step 2 (AutoCompact): Fork a summarization LLM call, replace the
   * conversation body with a single summary message pair, keep the
   * system prompt and the most recent `keepRecent` messages.
   */
  async compact(
    messages: Message[],
    keepRecent = 8,
  ): Promise<CompactResult> {
    // Separate system prompt from conversation
    const [systemMsg, ...conversation] = messages;

    // Keep the tail intact, summarize the head.
    // IMPORTANT: Never split between an [assistant: tool_calls] and its [tool: result]
    // messages — doing so produces orphaned tool-result messages that confuse the LLM
    // into re-calling the same tool repeatedly. Walk the boundary backward until it
    // lands on a user or bare assistant message (i.e., not a tool-result message and
    // not the result-half of an existing pair).
    let splitIdx = Math.max(0, conversation.length - keepRecent);
    while (splitIdx > 0 && conversation[splitIdx]?.role === "tool") {
      splitIdx--;
    }
    const toSummarize = conversation.slice(0, splitIdx);
    const recentMessages = conversation.slice(splitIdx);

    if (toSummarize.length === 0) {
      return { messages, summary: "", removedMessages: 0 };
    }

    // Build a plain-text transcript for the summarizer
    const transcript = toSummarize
      .map((m) => {
        const role = m.role === "tool" ? `tool(${m.name ?? ""})` : m.role;
        const content = m.content.slice(0, 2000); // cap per message for summarizer
        return `[${role}]: ${content}`;
      })
      .join("\n\n");

    const summaryMessages: Message[] = [
      { role: "system", content: COMPACT_PROMPT },
      { role: "user", content: transcript },
    ];

    let summary = "";
    for await (const event of this.modelProvider.streamChat(summaryMessages, {
      maxTokens: 2048,
    })) {
      if (event.type === "text_chunk") summary += event.text;
    }
    summary = summary.trim();

    // Reconstruct: system + summary pair + recent tail
    const compacted: Message[] = [
      ...(systemMsg ? [systemMsg] : []),
      {
        role: "user",
        content: `[Context summary of earlier conversation]\n${summary}`,
      },
      {
        role: "assistant",
        content: "Understood. I have reviewed the summary and will continue from where we left off.",
      },
      ...recentMessages,
    ];

    return {
      messages: compacted,
      summary,
      removedMessages: toSummarize.length,
    };
  }

  /**
   * Estimate token count using the provider's countTokens if available,
   * otherwise fall back to char/4 heuristic.
   */
  async estimateTokens(messages: Message[]): Promise<number> {
    try {
      return await this.modelProvider.countTokens(messages);
    } catch {
      const chars = messages.reduce((sum, m) => sum + m.content.length, 0);
      return Math.ceil(chars / 4);
    }
  }
}
