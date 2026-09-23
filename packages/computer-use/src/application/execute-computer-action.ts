import { computerActionSchema, type ComputerAction } from "../domain/computer-action.js";
import { ComputerOperationError, type ComputerObservation } from "../domain/computer-observation.js";
import type { ComputerRuntimePort } from "../ports/computer-runtime-port.js";

export class ExecuteComputerActionUseCase {
  constructor(private readonly runtime: ComputerRuntimePort) {}

  async execute(action: ComputerAction | Record<string, unknown>, signal?: AbortSignal): Promise<ComputerObservation> {
    if (signal?.aborted) throw new ComputerOperationError("aborted", "Computer action was aborted");
    const parsed = computerActionSchema.safeParse(action);
    if (!parsed.success) {
      throw new ComputerOperationError(
        "invalid_request",
        parsed.error.issues.map((issue) => `${issue.path.join(".") || "action"}: ${issue.message}`).join("; "),
        "Send exactly one action with either a revision-bound node target or complete screenshot coordinates.",
      );
    }
    return this.runtime.execute(parsed.data, signal);
  }
}
