import { z } from "zod";
import type { ITool, ToolContext, ToolResult } from "../entities.js";

interface RemoteActionConfig {
  url: string;
  description: string;
  token?: string;
}

const schema = z.object({
  action: z.string().min(1).describe("Registered remote action name"),
  payload: z.record(z.unknown()).describe("Small JSON payload for the remote action"),
});

function loadActions(): Record<string, RemoteActionConfig> {
  const raw = process.env.REMOTE_PROJECT_ACTIONS;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed as Record<string, RemoteActionConfig> : {};
  } catch {
    return {};
  }
}

function describeActions(actions: Record<string, RemoteActionConfig>): string {
  const lines = Object.entries(actions).map(([name, config]) => `- ${name}: ${config.description}`);
  return lines.length > 0 ? lines.join("\n") : "No remote actions are registered.";
}

export class RemoteProjectActionTool implements ITool {
  readonly name = "remote_project_action";
  readonly schema = schema;
  readonly parameters = {
    type: "object",
    properties: {
      action: { type: "string", description: "One registered action name. Use create_kid_earth_course to create a Kid Earth course when available." },
      payload: { type: "object", description: "Small action payload. For create_kid_earth_course use title, topic, chapterCount, ageRange." },
    },
    required: ["action", "payload"],
  };

  get description(): string {
    return `Execute a registered remote project action by POSTing action and payload to the project's endpoint. Use this instead of constructing complex business objects yourself. Registered actions:\n${describeActions(loadActions())}`;
  }

  async execute(params: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const parsed = this.schema.safeParse(params);
    if (!parsed.success) return { toolCallId: "", content: `Invalid parameters: ${parsed.error.message}`, isError: true };

    const actions = loadActions();
    const action = actions[parsed.data.action];
    if (!action) {
      return { toolCallId: "", content: `Unknown remote action: ${parsed.data.action}. Registered actions: ${Object.keys(actions).join(", ") || "none"}`, isError: true };
    }

    try {
      const response = await fetch(action.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(action.token ? { authorization: `Bearer ${action.token}` } : {}),
        },
        body: JSON.stringify({ action: parsed.data.action, payload: parsed.data.payload }),
      });
      const text = await response.text();
      if (!response.ok) return { toolCallId: "", content: `Remote action failed: ${response.status} ${text}`, isError: true };
      return { toolCallId: "", content: text };
    } catch (error) {
      return { toolCallId: "", content: error instanceof Error ? error.message : "Remote action failed", isError: true };
    }
  }
}
