import { z } from "zod";
import type { ITool, ToolContext, ToolResult } from '../entities.js';

export interface AskUserRequest {
  question: string;
  options?: Array<{ label: string; description: string }>;
  multiSelect?: boolean;
  toolCallId: string;
}

export interface AskUserResponse {
  /** The selected option label(s), or the free-text answer */
  answer: string;
  /** Indices of selected options (for multiSelect) */
  selectedIndices?: number[];
}

/**
 * Callback type: emits the question to the UI, then blocks until the user responds.
 * Implemented by the desktop host via IPC events.
 */
export type AskUserCallback = (request: AskUserRequest) => Promise<AskUserResponse>;

export class AskUserTool implements ITool {
  readonly name = "ask_user";
  readonly description =
    "Ask the user a question and wait for their response. " +
    "Use this when you need clarification, user preferences, or a decision before proceeding. " +
    "Provide clear options when possible so the user can quickly select. " +
    "The tool blocks until the user answers.";
  readonly schema = z.object({
    question: z.string().min(1).describe("The question to ask the user"),
    options: z.array(
      z.object({
        label: z.string().describe("Short display label for this option"),
        description: z.string().describe("Explanation of what this option means or implies"),
      }),
    ).optional().describe("2-4 selectable options. If omitted, the user types a free-text answer."),
    multiSelect: z.boolean().optional().describe("Allow selecting multiple options (default: false)"),
  });
  readonly parameters = {
    type: "object",
    properties: {
      question: { type: "string", description: "The question to ask the user" },
      options: {
        type: "array",
        description: "2-4 selectable options",
        items: {
          type: "object",
          properties: {
            label: { type: "string", description: "Short display label" },
            description: { type: "string", description: "What this option means" },
          },
          required: ["label", "description"],
        },
      },
      multiSelect: {
        type: "boolean",
        description: "Allow selecting multiple options (default: false)",
      },
    },
    required: ["question"],
  };

  constructor(
    private readonly askFn: AskUserCallback,
  ) {}

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

    try {
      const response = await this.askFn({
        question: parsed.data.question,
        options: parsed.data.options,
        multiSelect: parsed.data.multiSelect,
        toolCallId: "", // will be set by the executor
      });

      return {
        toolCallId: "",
        content: `User answered: ${response.answer}`,
      };
    } catch (err) {
      return {
        toolCallId: "",
        content: err instanceof Error ? err.message : "Failed to get user response",
        isError: true,
      };
    }
  }
}
