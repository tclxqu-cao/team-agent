import type { ComputerObservation } from "../domain/computer-observation.js";
import type { ComputerRuntimePort } from "../ports/computer-runtime-port.js";

export class ObserveComputerUseCase {
  constructor(private readonly runtime: ComputerRuntimePort) {}

  execute(signal?: AbortSignal): Promise<ComputerObservation> {
    return this.runtime.execute({ action: "observe" }, signal);
  }
}
