// ── Tool Domain ──

import type { ToolDefinition } from '../model/entities.js';
import { z, type ZodType } from "zod";

export interface ToolContext {
  workingDirectory: string;
  sessionId: string;
  signal?: AbortSignal;
}

export interface ITool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly schema: ZodType;

  execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

// Re-export from model for convenience
import type { ToolResult } from '../model/entities.js';
export type { ToolResult };

export interface IToolRegistry {
  register(tool: ITool): void;
  unregister(name: string): void;
  get(name: string): ITool | undefined;
  getAll(): ITool[];
  getDefinitions(): ToolDefinition[];
}

export interface IToolExecutor {
  execute(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult>;
  validate(name: string, args: Record<string, unknown>): boolean;
}
