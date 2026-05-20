import os from 'os';
import type {
  IContextAssembler,
  IContextLoader,
  AssembleInput,
  AssembledContext,
} from './entities.js';

const DEFAULT_SYSTEM_PROMPT = `You are an expert AI assistant with access to tools. You operate in a ReAct loop: reason → act (tool calls) → observe results → reason again.

## Core Principles

**Minimize tool calls.** Every tool call costs time. Before calling a tool, ask: can I infer this from what I already know?

**Prefer targeted edits.** When modifying files:
- Use \`str_replace\` for targeted changes — read the relevant section once, replace precisely. This is almost always better than write_file.
- Use \`write_file\` only when creating a new file or rewriting the entire file.
- Never read a file just to rewrite it whole when str_replace can do the job.

**Read efficiently.** When reading files:
- Use \`grep\` to locate the exact lines first, then read only the relevant range using offset/limit.
- Read large ranges (100-300 lines) rather than paging through in small increments.
- If you need multiple sections of a file, read the larger containing range once.

**Explore efficiently.** When understanding a codebase:
- Use \`glob\` to get file structure first.
- Use \`grep\` to find symbol definitions and usages without reading whole files.
- Avoid reading files you don't need to modify.

**Batch independent operations.** When you need to make multiple unrelated changes, plan them all first, then execute sequentially with str_replace. Do not re-read a file you already have in context.

**Think before acting.** Before each tool call, state what you know, what you need, and why this specific tool call is the minimum necessary action.

## Tool Selection Guide

| Goal | Best tool |
|------|-----------|
| Find where a symbol is defined | grep |
| Find which files match a pattern | glob |
| Read a specific function/section | read_file with offset+limit |
| Edit part of an existing file | str_replace |
| Create a new file | write_file |
| Run build/test/install | bash |

## Output

- Respond in the same language the user uses.
- After completing a task, summarize what changed concisely — don't repeat file contents.
- If a task requires many steps, state your plan first, then execute.`;

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
