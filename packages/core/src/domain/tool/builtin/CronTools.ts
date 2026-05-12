import { z } from "zod";
import type { ITool, ToolContext, ToolResult } from '../entities.js';
import type { CronTasks, CronTask } from '../../cron/index.js';
import { isCronExpression, parseIntervalMs } from '../../cron/index.js';

// ── CronCreateTool ──────────────────────────────────────────────────────────

export type CronCreateFn = (cron: string, prompt: string, options?: { label?: string; recurring?: boolean; sessionId?: string }) => CronTask;

export class CronCreateTool implements ITool {
  readonly name = "cron_create";
  readonly description =
    "Create a scheduled task that runs a prompt on a cron schedule. " +
    "Use cron expressions (e.g. '0 9 * * *' for 9am daily, '*/5 * * * *' for every 5 min) " +
    "or interval shorthands ('5m', '2h', '30s'). " +
    "Set recurring=false for one-time tasks (default is true for repeating).";
  readonly schema = z.object({
    cron: z.string().describe("Cron expression or interval shorthand"),
    prompt: z.string().describe("Prompt to execute when the task fires"),
    label: z.string().optional().describe("Optional human-readable label"),
    recurring: z.boolean().default(true).describe("Repeat (true) or fire once (false)"),
  });
  readonly parameters = {
    type: "object",
    properties: {
      cron: { type: "string", description: "Cron expression or interval shorthand (5m, 2h, '0 9 * * *')" },
      prompt: { type: "string", description: "Prompt to execute when the task fires" },
      label: { type: "string", description: "Optional human-readable label" },
      recurring: { type: "boolean", description: "Repeat (true) or fire once (false)", default: true },
    },
    required: ["cron", "prompt"],
  };

  constructor(private readonly onCreate: CronCreateFn) {}

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const parsed = this.schema.safeParse(params);
    if (!parsed.success) {
      return { toolCallId: "", content: `Invalid params: ${parsed.error.message}`, isError: true };
    }
    const { cron, prompt, label, recurring } = parsed.data;

    if (parseIntervalMs(cron) === null && !isCronExpression(cron)) {
      return { toolCallId: "", content: `Invalid cron expression: "${cron}"`, isError: true };
    }

    // Always bind the task to the current session (from ctx), so notifications
    // are delivered here. The caller never needs to pass sessionId manually.
    const task = this.onCreate(cron, prompt, { label, recurring, sessionId: ctx.sessionId });
    return { toolCallId: "", content: JSON.stringify(task, null, 2) };
  }
}

// ── CronDeleteTool ──────────────────────────────────────────────────────────

export class CronDeleteTool implements ITool {
  readonly name = "cron_delete";
  readonly description = "Delete a scheduled task by ID or ID prefix.";
  readonly schema = z.object({
    id: z.string().describe("Task ID or ID prefix to delete"),
  });
  readonly parameters = {
    type: "object",
    properties: {
      id: { type: "string", description: "Task ID or prefix" },
    },
    required: ["id"],
  };

  constructor(private readonly cronTasks: CronTasks) {}

  async execute(params: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const parsed = this.schema.safeParse(params);
    if (!parsed.success) {
      return { toolCallId: "", content: `Invalid params: ${parsed.error.message}`, isError: true };
    }
    const ok = this.cronTasks.delete(parsed.data.id);
    return {
      toolCallId: "",
      content: ok ? `Task "${parsed.data.id}" deleted.` : `Task not found: "${parsed.data.id}"`,
      isError: !ok,
    };
  }
}

// ── CronListTool ────────────────────────────────────────────────────────────

export class CronListTool implements ITool {
  readonly name = "cron_list";
  readonly description = "List all scheduled tasks.";
  readonly schema = z.object({});
  readonly parameters = { type: "object", properties: {} };

  constructor(private readonly cronTasks: CronTasks) {}

  async execute(_params: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const tasks = this.cronTasks.list();
    if (tasks.length === 0) return { toolCallId: "", content: "No scheduled tasks." };
    return { toolCallId: "", content: JSON.stringify(tasks, null, 2) };
  }
}
