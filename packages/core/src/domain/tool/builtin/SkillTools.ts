import { z } from "zod";
import type { SkillRegistry } from "../../skill/SkillRegistry.js";
import type { ITool, ToolContext, ToolResult } from "../entities.js";

const EPHEMERAL_SKILL_METADATA = { ephemeralSkillContext: true };

export class SkillDiscoverTool implements ITool {
  readonly name = "skill_discover";
  readonly description =
    "Search available skill metadata when the user's request may require specialized instructions. " +
    "Do not call for simple questions that can be answered directly. This returns names and descriptions only; " +
    "call skill_load with an exact name before following a skill.";
  readonly schema = z.object({
    query: z.string().min(1).describe("Short capability or task description to search for"),
  });
  readonly parameters = {
    type: "object",
    properties: {
      query: { type: "string", description: "Short capability or task description to search for" },
    },
    required: ["query"],
  };

  constructor(
    private readonly registry: SkillRegistry,
    private readonly enabledSkills: string[] | null,
  ) {}

  async execute(params: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const parsed = this.schema.safeParse(params);
    if (!parsed.success) return this.error(parsed.error.message);
    const matches = this.registry.discover(parsed.data.query, this.enabledSkills);
    const candidates = matches.length > 0 ? matches : this.registry.discover("", this.enabledSkills);
    return {
      toolCallId: "",
      content: JSON.stringify({
        skills: candidates.map(({ name, description, source }) => ({ name, description, source })),
        exactMatches: matches.length > 0,
      }),
      metadata: EPHEMERAL_SKILL_METADATA,
    };
  }

  private error(message: string): ToolResult {
    return { toolCallId: "", content: `Invalid parameters: ${message}`, isError: true, metadata: EPHEMERAL_SKILL_METADATA };
  }
}

export class SkillLoadTool implements ITool {
  readonly name = "skill_load";
  readonly description =
    "Load the complete instructions for one exact skill selected from skill_discover. " +
    "Use the returned instructions only for the current task.";
  readonly schema = z.object({
    name: z.string().min(1).describe("Exact skill name returned by skill_discover"),
  });
  readonly parameters = {
    type: "object",
    properties: {
      name: { type: "string", description: "Exact skill name returned by skill_discover" },
    },
    required: ["name"],
  };

  constructor(
    private readonly registry: SkillRegistry,
    private readonly enabledSkills: string[] | null,
  ) {}

  async execute(params: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const parsed = this.schema.safeParse(params);
    if (!parsed.success) return this.error(parsed.error.message);
    const skill = await this.registry.load(parsed.data.name, this.enabledSkills);
    if (!skill) {
      return {
        toolCallId: "",
        content: `Skill not found or not enabled: ${parsed.data.name}`,
        isError: true,
        metadata: EPHEMERAL_SKILL_METADATA,
      };
    }
    return {
      toolCallId: "",
      content: `## Skill: ${skill.name}\n${skill.prompt}`,
      metadata: EPHEMERAL_SKILL_METADATA,
    };
  }

  private error(message: string): ToolResult {
    return { toolCallId: "", content: `Invalid parameters: ${message}`, isError: true, metadata: EPHEMERAL_SKILL_METADATA };
  }
}
