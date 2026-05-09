import os from 'os';
import type {
  IContextAssembler,
  IContextLoader,
  AssembleInput,
  AssembledContext,
} from './entities.js';

const DEFAULT_SYSTEM_PROMPT = `You are a helpful AI assistant. You have access to tools that you can use to help with tasks.
Use tools when appropriate to gather information or perform actions.

When using tools:
- Think step by step about which tool to use
- Use the most specific tool for the task
- Provide clear parameters
- After receiving tool results, incorporate them into your response

Always respond in the language the user uses.`;

export class ContextAssembler implements IContextAssembler {
  constructor(private readonly contextLoader: IContextLoader) {}

  async assemble(input: AssembleInput): Promise<AssembledContext> {
    const maxTokens = input.maxTokens ?? 100_000;
    const basePrompt = input.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;

    // Load project context
    const projectFiles = await this.contextLoader.loadProjectContext(input.rootDir);

    let systemPrompt = basePrompt;

    // Inject runtime environment info
    const envInfo = [
      `- Working directory: ${input.rootDir}`,
      `- OS: ${os.type()} ${os.release()} (${os.arch()})`,
      `- Current time: ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    ].join('\n');
    systemPrompt += `\n\n## Environment\n${envInfo}`;

    // Add project context
    if (projectFiles.length > 0) {
      systemPrompt += "\n\n## Project Context\n";
      for (const file of projectFiles) {
        const truncated = this.truncateContent(file.content, 5000);
        systemPrompt += `\n### ${file.path}\n${truncated}`;
      }
    }

    // Add skill prompts
    if (input.skillPrompts) {
      systemPrompt += `\n\n## Available Skills\n${input.skillPrompts}`;
    }

    // Add tool definitions
    if (input.tools && input.tools !== "[]") {
      systemPrompt += `\n\n## Available Tools\n${input.tools}`;
    }

    // Add memory context
    if (input.memoryContext) {
      systemPrompt += `\n\n## Relevant Memories\n${input.memoryContext}`;
    }

    // Estimate tokens
    const tokenUsed = this.estimateTokens(systemPrompt) + this.estimateTokens(input.userMessage);

    // Truncate if over budget
    if (tokenUsed > maxTokens) {
      systemPrompt = this.truncateToBudget(systemPrompt, maxTokens - this.estimateTokens(input.userMessage) - 1000);
    }

    return {
      systemPrompt,
      messages: input.history,
      tokenBudget: maxTokens,
      tokenUsed: Math.min(tokenUsed, maxTokens),
    };
  }

  private truncateContent(content: string, maxLen: number): string {
    if (content.length <= maxLen) return content;
    return content.slice(0, maxLen) + "\n... (truncated)";
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  private truncateToBudget(text: string, tokenBudget: number): string {
    const charBudget = tokenBudget * 4;
    if (text.length <= charBudget) return text;

    // Cut from the middle where project context usually is
    const sections = text.split("\n## ");
    let result = sections[0];
    let remaining = charBudget - result.length;

    for (let i = 1; i < sections.length && remaining > 0; i++) {
      const section = "## " + sections[i];
      if (section.length <= remaining) {
        result += "\n" + section;
        remaining -= section.length;
      } else {
        result += "\n" + section.slice(0, remaining) + "\n... (truncated)";
        break;
      }
    }

    return result;
  }
}
