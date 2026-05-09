// ── Context Domain ──

import type { Message } from '../model/entities.js';

export interface ProjectFile {
  path: string;
  content: string;
  type: "claude_md" | "readme" | "code" | "config" | "other";
}

export interface AssembledContext {
  systemPrompt: string;
  messages: Message[];
  tokenBudget: number;
  tokenUsed: number;
}

export interface IContextLoader {
  /** Discover and load project context files (CLAUDE.md, README, etc.) */
  loadProjectContext(rootDir: string): Promise<ProjectFile[]>;
  /** Load a specific file */
  loadFile(filePath: string): Promise<ProjectFile>;
  /** Find CLAUDE.md files recursively */
  findClaudeMdFiles(rootDir: string): Promise<string[]>;
}

export interface IContextAssembler {
  /** Assemble the full context for an agent run */
  assemble(input: AssembleInput): Promise<AssembledContext>;
}

export interface AssembleInput {
  rootDir: string;
  userMessage: string;
  history: Message[];
  tools: string; // serialized tool definitions
  memoryContext: string;
  skillPrompts: string;
  systemPrompt?: string; // override
  maxTokens?: number;
}
