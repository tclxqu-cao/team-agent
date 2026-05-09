import type { ITool, IToolRegistry, IToolExecutor, ToolContext, ToolResult } from './entities.js';

export class ToolRegistry implements IToolRegistry, IToolExecutor {
  private readonly tools = new Map<string, ITool>();

  register(tool: ITool): void {
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): ITool | undefined {
    return this.tools.get(name);
  }

  getAll(): ITool[] {
    return Array.from(this.tools.values());
  }

  getDefinitions() {
    return this.getAll().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { toolCallId: "", content: `Unknown tool: ${name}`, isError: true };
    }
    return tool.execute(args, ctx);
  }

  validate(name: string, args: Record<string, unknown>): boolean {
    const tool = this.tools.get(name);
    if (!tool) return false;
    const result = tool.schema.safeParse(args);
    return result.success;
  }
}
