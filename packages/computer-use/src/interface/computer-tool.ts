import type { ITool, ToolContext, ToolResult } from "@agent/core";
import { computerActionSchema } from "../domain/computer-action.js";
import {
  ComputerOperationError,
  isComputerErrorCode,
  type ComputerObservation,
} from "../domain/computer-observation.js";
import { ExecuteComputerActionUseCase } from "../application/execute-computer-action.js";
import type { ComputerRuntimePort } from "../ports/computer-runtime-port.js";

export const COMPUTER_TOOL_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: {
      type: "string",
      enum: ["observe", "press", "click", "double_click", "type", "keypress", "scroll", "move", "drag", "wait", "screenshot"],
    },
    revision: { type: "string", description: "Revision from the latest Accessibility observation." },
    nodeId: { type: "string", description: "Node ID from the same revision." },
    x: { type: "number", minimum: 0, description: "X coordinate in the latest screenshot pixels." },
    y: { type: "number", minimum: 0, description: "Y coordinate in the latest screenshot pixels." },
    button: { type: "string", enum: ["left", "right", "middle"] },
    text: { type: "string", maxLength: 10_000 },
    replace: { type: "boolean" },
    keys: { type: "array", minItems: 1, maxItems: 16, items: { type: "string" } },
    deltaX: { type: "number" },
    deltaY: { type: "number" },
    startX: { type: "number", minimum: 0 },
    startY: { type: "number", minimum: 0 },
    endX: { type: "number", minimum: 0 },
    endY: { type: "number", minimum: 0 },
    durationMs: { type: "integer", minimum: 0, maximum: 5_000 },
  },
  allOf: [
    {
      if: { properties: { action: { const: "press" } } },
      then: { required: ["revision", "nodeId"] },
    },
    {
      if: { properties: { action: { const: "type" } } },
      then: { required: ["revision", "nodeId", "text"] },
    },
    {
      if: { properties: { action: { const: "keypress" } } },
      then: { required: ["keys"] },
    },
    {
      if: { properties: { action: { const: "drag" } } },
      then: { required: ["startX", "startY", "endX", "endY"] },
    },
    {
      if: { properties: { action: { const: "wait" } } },
      then: { required: ["durationMs"] },
    },
  ],
} as const;

function textualObservation(observation: ComputerObservation): object {
  if (observation.source === "accessibility") return observation;
  return {
    ...observation,
    image: {
      mimeType: observation.image.mimeType,
      width: observation.image.width,
      height: observation.image.height,
      logicalWidth: observation.image.logicalWidth,
      logicalHeight: observation.image.logicalHeight,
      originX: observation.image.originX,
      originY: observation.image.originY,
    },
  };
}

function publicObservation(observation: ComputerObservation): object {
  if (observation.source === "accessibility") {
    return {
      source: observation.source,
      revision: observation.revision,
      coverage: observation.coverage,
      nodeCount: observation.nodes.length,
      ...(observation.truncated === undefined ? {} : { truncated: observation.truncated }),
    };
  }
  return {
    source: observation.source,
    revision: observation.revision,
    coverage: observation.coverage,
    reason: observation.reason,
    image: {
      mimeType: observation.image.mimeType,
      width: observation.image.width,
      height: observation.image.height,
    },
  };
}

export class ComputerTool implements ITool {
  readonly name = "computer";
  readonly authorization = "direct" as const;
  readonly schema = computerActionSchema;
  readonly parameters = COMPUTER_TOOL_PARAMETERS;
  readonly description = [
    "Observe and control the frontmost macOS application, one action per call.",
    "Use this tool only when the user explicitly asks you to operate the computer, or when the task cannot continue without observing or interacting with a GUI.",
    "If neither condition applies, do not call this tool.",
    "The tool being available is not permission or a reason to call it.",
    "Never call this tool speculatively, for convenience, or merely because it is available.",
    "Do not use it for file, shell, API, or browser work that an existing purpose-built tool can complete.",
    "Call observe first and prefer revision-bound node actions from the Accessibility tree.",
    "If Accessibility coverage is partial and the target is absent, call screenshot, then use screenshot pixel coordinates.",
    "Never reuse a nodeId after a newer observation; stale revisions must be observed again.",
    "If the runtime reports desktop_locked, stop computer actions until the user unlocks the Mac, then observe again.",
  ].join(" ");
  private readonly executeAction: ExecuteComputerActionUseCase;

  constructor(runtime: ComputerRuntimePort) {
    this.executeAction = new ExecuteComputerActionUseCase(runtime);
  }

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const observation = await this.executeAction.execute(params, ctx.signal);
      return {
        toolCallId: "",
        content: JSON.stringify(publicObservation(observation)),
        modelContent: JSON.stringify(textualObservation(observation)),
        ...(observation.source === "screenshot" ? {
          modelAttachments: [{
            type: "image" as const,
            mimeType: observation.image.mimeType,
            dataUrl: observation.image.dataUrl,
            width: observation.image.width,
            height: observation.image.height,
          }],
        } : {}),
      };
    } catch (error) {
      const candidate = error && typeof error === "object"
        ? error as { code?: unknown; message?: unknown; recovery?: unknown }
        : null;
      const failure = error instanceof ComputerOperationError
        ? error
        : candidate && isComputerErrorCode(candidate.code)
          ? new ComputerOperationError(
              candidate.code,
              typeof candidate.message === "string" ? candidate.message : String(error),
              typeof candidate.recovery === "string" ? candidate.recovery : undefined,
            )
          : new ComputerOperationError("protocol_error", error instanceof Error ? error.message : String(error));
      return {
        toolCallId: "",
        isError: true,
        content: JSON.stringify({
          error: failure.code,
          message: failure.message,
          ...(failure.recovery ? { recovery: failure.recovery } : {}),
        }),
      };
    }
  }
}
