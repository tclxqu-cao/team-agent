import type { Message } from '../model/entities.js';
import type { IModelProvider } from '../model/entities.js';

const COMPACT_PROMPT = `You are summarizing a conversation for handoff to another model that will continue the task.

Your summary must preserve the exact information needed to continue without reading the original transcript.

Include:
- Current progress and key decisions
- Important context, constraints, and user preferences
- Concrete files, symbols, commands, errors, data, examples, and references that matter
- What remains to be done, with clear next steps

Output ONLY the handoff summary text, no preamble or meta-commentary.`;

export const COMPACTION_SUMMARY_PREFIX = `This is a summary of the conversation so far, written to preserve continuity after context compaction.`;
export const COMPACTION_ACKNOWLEDGEMENT = "Understood. I have reviewed the summary and will continue from where we left off.";
const COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000;
const TOOL_RESULT_TRUNCATE = 500;

export interface CompactResult {
  /** Compacted message list: [system, summary-user, summary-assistant, ...recentMessages] */
  messages: Message[];
  summary: string;
  removedMessages: number;
}

export interface ActiveCompactResult {
  /** Messages to persist for the session. Runtime/system environment is injected again on the next run. */
  replacementMessages: Message[];
  summary: string;
  recentMessages: Message[];
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
      reasoningEffort: "off",
    })) {
      if (event.type === "text_chunk") summary += event.text;
    }
    summary = summary.trim();

    // Reconstruct: system + summary pair + recent tail
    const compacted: Message[] = [
      ...(systemMsg ? [systemMsg] : []),
      {
        role: "user",
        content: `${COMPACTION_SUMMARY_PREFIX}\n${summary}`,
      },
      {
        role: "assistant",
        content: COMPACTION_ACKNOWLEDGEMENT,
      },
      ...recentMessages,
    ];

    return {
      messages: compacted,
      summary,
      removedMessages: toSummarize.length,
    };
  }

  async compactForHandoff(messages: Message[]): Promise<ActiveCompactResult> {
    const conversation = messages.filter(
      (m) => m.role !== "system" && m.name !== "__compaction_checkpoint__" && !this.isSummaryMessage(m),
    );
    if (conversation.length === 0) {
      return { replacementMessages: [], summary: "", recentMessages: [], removedMessages: 0 };
    }

    const transcript = conversation
      .map((m) => {
        const role = m.role === "tool" ? `tool(${m.name ?? ""})` : m.role;
        const content = m.content.slice(0, 4000);
        return `[${role}]: ${content}`;
      })
      .join("\n\n");

    const summaryMessages: Message[] = [
      { role: "system", content: COMPACT_PROMPT },
      { role: "user", content: transcript },
    ];

    let summary = "";
    for await (const event of this.modelProvider.streamChat(summaryMessages, {
      maxTokens: 4096,
      reasoningEffort: "off",
    })) {
      if (event.type === "text_chunk") summary += event.text;
    }
    summary = summary.trim();

    const recentMessages = this.collectRecentUserMessages(conversation);
    const replacementMessages: Message[] = [
      ...recentMessages,
      { role: "user", content: `${COMPACTION_SUMMARY_PREFIX}\n${summary}` },
    ];

    return {
      replacementMessages,
      summary,
      recentMessages,
      removedMessages: Math.max(0, conversation.length - replacementMessages.length),
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

  private collectRecentUserMessages(messages: Message[]): Message[] {
    const selected: Message[] = [];
    let usedTokens = 0;

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== "user" || this.isSummaryMessage(msg)) continue;

      const tokenCount = Math.ceil(msg.content.length / 4);
      const remaining = COMPACT_USER_MESSAGE_MAX_TOKENS - usedTokens;
      if (remaining <= 0) break;

      if (tokenCount <= remaining) {
        selected.push(msg);
        usedTokens += tokenCount;
        continue;
      }

      selected.push({
        ...msg,
        content: msg.content.slice(-remaining * 4),
      });
      break;
    }

    return selected.reverse();
  }

  private isSummaryMessage(message: Message): boolean {
    return message.role === "user" && message.content.startsWith(COMPACTION_SUMMARY_PREFIX);
  }
}
