import { z } from "zod";
import type { ITool, ToolContext, ToolResult } from '../entities.js';
import type { TodoItem } from '../../agent/entities.js';

export class TodoAddTool implements ITool {
  readonly name = "todo_add";
  readonly description =
    "Add one or more tasks to the shared todo list. Use this to plan and coordinate work, " +
    "especially when multiple agents will handle different parts of the task. " +
    "Each todo can be assigned to a specific agent by name.";
  readonly schema = z.object({
    todos: z.array(
      z.object({
        title: z.string().describe("Task description"),
        agentName: z.string().optional().describe("Name of the agent responsible for this task"),
      }),
    ).min(1).describe("List of tasks to add"),
  });
  readonly parameters = {
    type: "object",
    properties: {
      todos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "Task description" },
            agentName: { type: "string", description: "Name of agent responsible for this task" },
          },
          required: ["title"],
        },
        description: "List of tasks to add",
      },
    },
    required: ["todos"],
  };

  constructor(
    private readonly getTodos: () => TodoItem[],
    private readonly setTodos: (todos: TodoItem[]) => void,
  ) {}

  async execute(params: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const parsed = this.schema.safeParse(params);
    if (!parsed.success) {
      return { toolCallId: "", content: `Invalid params: ${parsed.error.message}`, isError: true };
    }
    const current = this.getTodos();
    const newItems: TodoItem[] = parsed.data.todos.map((t) => ({
      id: crypto.randomUUID(),
      title: t.title,
      agentName: t.agentName,
      status: "pending" as const,
    }));
    this.setTodos([...current, ...newItems]);
    return {
      toolCallId: "",
      content: `Added ${newItems.length} todo(s): ${newItems.map((t) => `"${t.title}"`).join(", ")}`,
    };
  }
}

export class TodoUpdateTool implements ITool {
  readonly name = "todo_update";
  readonly description =
    "Update the status of a todo item. Use 'in-progress' when starting a task, " +
    "'completed' when finished. Match by id or partial title.";
  readonly schema = z.object({
    id: z.string().optional().describe("Todo item ID (exact match)"),
    title: z.string().optional().describe("Todo item title (partial case-insensitive match)"),
    status: z.enum(["pending", "in-progress", "completed"]).describe("New status"),
  }).refine((d) => d.id !== undefined || d.title !== undefined, {
    message: "Provide either id or title",
  });
  readonly parameters = {
    type: "object",
    properties: {
      id: { type: "string", description: "Todo item ID (exact match)" },
      title: { type: "string", description: "Todo item title (partial match)" },
      status: {
        type: "string",
        enum: ["pending", "in-progress", "completed"],
        description: "New status",
      },
    },
    required: ["status"],
  };

  constructor(
    private readonly getTodos: () => TodoItem[],
    private readonly setTodos: (todos: TodoItem[]) => void,
  ) {}

  async execute(params: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const parsed = this.schema.safeParse(params);
    if (!parsed.success) {
      return { toolCallId: "", content: `Invalid params: ${parsed.error.message}`, isError: true };
    }
    const todos = this.getTodos();
    let matched = false;
    const updated = todos.map((t) => {
      const byId = parsed.data.id !== undefined && t.id === parsed.data.id;
      const byTitle =
        parsed.data.title !== undefined &&
        t.title.toLowerCase().includes(parsed.data.title.toLowerCase());
      if (byId || byTitle) {
        matched = true;
        return { ...t, status: parsed.data.status };
      }
      return t;
    });
    if (!matched) {
      return { toolCallId: "", content: `No matching todo found for: ${JSON.stringify(parsed.data)}`, isError: true };
    }
    this.setTodos(updated);
    return { toolCallId: "", content: `Updated todo status to "${parsed.data.status}"` };
  }
}

export class TodoListTool implements ITool {
  readonly name = "todo_list";
  readonly description =
    "List all current todo items with their statuses. Use this to check what tasks " +
    "are planned, in progress, or completed.";
  readonly schema = z.object({});
  readonly parameters = {
    type: "object",
    properties: {},
    required: [],
  };

  constructor(private readonly getTodos: () => TodoItem[]) {}

  async execute(_params: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const todos = this.getTodos();
    if (todos.length === 0) {
      return { toolCallId: "", content: "No todos yet." };
    }
    const statusIcon = (s: string) =>
      s === "completed" ? "✓" : s === "in-progress" ? "→" : "○";
    const lines = todos.map(
      (t, i) =>
        `${i + 1}. [${statusIcon(t.status)}] ${t.title}${t.agentName ? ` (@${t.agentName})` : ""}`,
    );
    return { toolCallId: "", content: lines.join("\n") };
  }
}
