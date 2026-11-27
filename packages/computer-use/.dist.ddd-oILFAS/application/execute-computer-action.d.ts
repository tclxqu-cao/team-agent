import { type ComputerAction } from "../domain/computer-action.js";
import { type ComputerObservation } from "../domain/computer-observation.js";
import type { ComputerRuntimePort } from "../ports/computer-runtime-port.js";
export declare class ExecuteComputerActionUseCase {
    private readonly runtime;
    constructor(runtime: ComputerRuntimePort);
    execute(action: ComputerAction | Record<string, unknown>, signal?: AbortSignal): Promise<ComputerObservation>;
}
//# sourceMappingURL=execute-computer-action.d.ts.map