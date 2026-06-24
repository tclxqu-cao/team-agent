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
- Use \`apply_patch\` for multi-hunk or multi-file edits — provide a unified diff (like \`git diff\`). Best for batch changes across a project.
- Use \`str_replace\` for single targeted changes — read the relevant section once, replace precisely. Best for small surgical edits.
- Use \`write_file\` only when creating a new file or rewriting the entire file.
- Never read a file just to rewrite it whole when str_replace or apply_patch can do the job.

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
| Edit part of an existing file | str_replace or apply_patch |
| Edit multiple files / multiple hunks | apply_patch |
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

    // ── Build sections independently ──

    // 1. Environment info (always included, small)
    const envSection = this.buildEnvSection(input.rootDir);

    // 2. Tool definitions (high priority — needed for function calling)
    const toolsSection = (input.tools && input.tools !== "[]")
      ? `## Available Tools\n${input.tools}`
      : "";

    // 3. Skill prompts (medium priority)
    let skillsSection = "";
    if (input.skillPrompts) {
      skillsSection = `## Available Skills\n${input.skillPrompts}`
        + `\n\n## Skill Activation Rule\nIf the user's request clearly matches any skill described above, you MUST follow that skill's instructions for this turn. Apply the skill's guidance throughout your response. If multiple skills match, apply all of them in the order listed.`;
    }

    // 4. Memory context (medium-low priority — supplementary)
    const memorySection = input.memoryContext
      ? `## Relevant Memories\n${input.memoryContext}`
      : "";

    // 5. Project context (lowest priority — truncated first)
    let projectSection = "";
    if (projectFiles.length > 0) {
      projectSection = "## Project Context";
      for (const file of projectFiles) {
        projectSection += `\n\n### ${file.path}\n${file.content}`;
      }
    }

    // ── Token budget allocation ──
    const userMsgTokens = this.estimateTokens(input.userMessage);
    const historyTokens = this.estimateHistoryTokens(input.history);
    const baseTokens = this.estimateTokens(basePrompt);
    const envTokens = this.estimateTokens(envSection);

    // Fixed costs: base prompt + environment + user message + history + safety margin
    const safetyMargin = 500;
    const fixedCost = baseTokens + envTokens + userMsgTokens + historyTokens + safetyMargin;
    const remainingBudget = Math.max(0, maxTokens - fixedCost);

    // Priority-based allocation (percentages of remaining budget)
    // Tools & skills are essential; memory & project are supplementary
    const TOOL_RATIO = 0.30;
    const SKILL_RATIO = 0.15;
    const MEMORY_RATIO = 0.20;
    // Project gets the rest: 1 - 0.30 - 0.15 - 0.20 = 0.35

    const toolBudget = Math.floor(remainingBudget * TOOL_RATIO);
    const skillBudget = Math.floor(remainingBudget * SKILL_RATIO);
    const memoryBudget = Math.floor(remainingBudget * MEMORY_RATIO);
    let projectBudget = remainingBudget - toolBudget - skillBudget - memoryBudget;

    // Truncate each section to its allocated budget
    const truncatedTools = this.truncateSection(toolsSection, toolBudget);
    const truncatedSkills = this.truncateSection(skillsSection, skillBudget);
    const truncatedMemory = this.truncateSection(memorySection, memoryBudget);

    // Redistribute unused budget to project context (lowest priority gets the surplus)
    const toolSurplus = toolBudget - this.estimateTokens(truncatedTools);
    const skillSurplus = skillBudget - this.estimateTokens(truncatedSkills);
    const memorySurplus = memoryBudget - this.estimateTokens(truncatedMemory);
    projectBudget += Math.max(0, toolSurplus) + Math.max(0, skillSurplus) + Math.max(0, memorySurplus);
    const truncatedProject = this.truncateProjectSection(projectSection, projectBudget);

    // ── Assemble final system prompt (priority order: base → env → project → skills → tools → memory) ──
    let systemPrompt = `${basePrompt}\n\n${envSection}`;
    if (truncatedProject) systemPrompt += `\n\n${truncatedProject}`;
    if (truncatedSkills) systemPrompt += `\n\n${truncatedSkills}`;
    if (truncatedTools) systemPrompt += `\n\n${truncatedTools}`;
    if (truncatedMemory) systemPrompt += `\n\n${truncatedMemory}`;

    // Final safety: truncate entire prompt if still over budget
    // (e.g. when base prompt alone exceeds the budget)
    let tokenUsed = this.estimateTokens(systemPrompt) + userMsgTokens + historyTokens;
    if (tokenUsed > maxTokens) {
      const promptBudget = Math.max(0, maxTokens - userMsgTokens - historyTokens);
      systemPrompt = this.truncateToBudget(systemPrompt, promptBudget);
      tokenUsed = this.estimateTokens(systemPrompt) + userMsgTokens + historyTokens;
    }

    return {
      systemPrompt,
      messages: input.history,
      tokenBudget: maxTokens,
      tokenUsed: Math.min(tokenUsed, maxTokens),
    };
  }

  // ── Section builders ──

  private buildEnvSection(rootDir: string): string {
    const envInfo = [
      `- Working directory: ${rootDir}`,
      `- OS: ${os.type()} ${os.release()} (${os.arch()})`,
      `- Current time: ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    ].join('\n');
    return `## Environment\n${envInfo}`;
  }

  // ── Token estimation ──

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  private estimateHistoryTokens(messages: AssembleInput['history']): number {
    if (!messages || messages.length === 0) return 0;
    let total = 0;
    for (const msg of messages) {
      total += this.estimateTokens(typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content));
      // Each message has overhead (role, metadata)
      total += 4;
    }
    return total;
  }

  // ── Section truncation ──

  /** Truncate a section to fit within a token budget. */
  private truncateSection(section: string, tokenBudget: number): string {
    if (!section || tokenBudget <= 0) return "";
    const charBudget = tokenBudget * 4;
    if (section.length <= charBudget) return section;
    return section.slice(0, charBudget) + "\n... (truncated)";
  }

  /**
   * Truncate the project context section intelligently:
   * keep file headers, truncate individual file contents proportionally.
   */
  private truncateProjectSection(section: string, tokenBudget: number): string {
    if (!section || tokenBudget <= 0) return "";
    const charBudget = tokenBudget * 4;
    if (section.length <= charBudget) return section;

    // Split into file blocks by "### " header
    const header = "## Project Context";
    const fileBlocks: Array<{ header: string; content: string }> = [];
    const parts = section.slice(header.length).split(/\n(?=### )/);
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const headerEnd = trimmed.indexOf('\n');
      if (headerEnd === -1) {
        fileBlocks.push({ header: trimmed, content: "" });
      } else {
        fileBlocks.push({
          header: trimmed.slice(0, headerEnd),
          content: trimmed.slice(headerEnd + 1),
        });
      }
    }

    if (fileBlocks.length === 0) return section.slice(0, charBudget);

    // Reserve space for section header + all file headers
    const headerOverhead = header.length + fileBlocks.reduce((sum, f) => sum + f.header.length + 2, 0);
    const contentBudget = charBudget - headerOverhead;
    if (contentBudget <= 0) {
 // Can't even fit headers — return what we can
      return section.slice(0, charBudget);
    }

    // Distribute content budget equally across files
    const perFile = Math.floor(contentBudget / fileBlocks.length);
    let result = header;
    for (const block of fileBlocks) {
      result += `\n\n${block.header}`;
      if (block.content.length <= perFile) {
        result += `\n${block.content}`;
      } else {
        result += `\n${block.content.slice(0, perFile)}\n... (truncated)`;
      }
    }
    return result;
  }

  /** Fallback: truncate the entire system prompt by cutting sections from the end. */
  private truncateToBudget(text: string, tokenBudget: number): string {
    const charBudget = tokenBudget * 4;
    if (text.length <= charBudget) return text;

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
