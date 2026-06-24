import { z } from "zod";
import type { ITool, ToolContext, ToolResult } from '../entities.js';
import { randomUUID } from "node:crypto";

export class ShowWidgetTool implements ITool {
  readonly name = "show_widget";
  readonly description =
    "Display a custom UI card in the chat. " +
    "Use widget_type to specify the card type and data to pass structured content. " +
    "Use update_id to update an existing card instead of creating a new one.";
  readonly schema = z.object({
    widget_type: z.string().describe("Card type identifier, e.g. 'storyboard_workbench'"),
    data: z.record(z.unknown()).describe("Structured data for the card to render"),
    update_id: z.string().optional().describe("ID of existing widget to update (omit to create new)"),
  });
  readonly parameters = this.schemaToParams();

  private schemaToParams(): Record<string, unknown> {
    const shape = (this.schema as z.ZodObject<z.ZodRawShape>).shape;
    const props: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(shape)) {
      const def = (val as z.ZodTypeAny)._def;
      const desc = def.description ?? "";
      const inner = def.innerType ?? val;
      const typeName: string = inner._def?.typeName ?? def.typeName ?? "";
      let type = "string";
      if (typeName === "ZodNumber") type = "number";
      else if (typeName === "ZodBoolean") type = "boolean";
      else if (typeName === "ZodRecord") type = "object";
      props[key] = { type, description: desc };
    }
    return {
      type: "object",
      properties: props,
      required: ["widget_type", "data"],
    };
  }

  async execute(
    params: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const parsed = this.schema.safeParse(params);
    if (!parsed.success) {
      return {
        toolCallId: "",
        content: `Invalid parameters: ${parsed.error.message}`,
        isError: true,
      };
    }

    const widgetId = parsed.data.update_id ?? `w-${randomUUID().slice(0, 8)}`;
    const widgetType = parsed.data.widget_type;
    const data = parsed.data.data;

    const payload = JSON.stringify({ widgetId, widgetType, data });
    return {
      toolCallId: "",
      content: `Widget displayed: ${payload}`,
      metadata: { showWidget: { widgetId, widgetType, data } },
    };
  }
}
