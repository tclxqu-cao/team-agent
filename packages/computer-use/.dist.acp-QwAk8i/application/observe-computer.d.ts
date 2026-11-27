import type { ComputerObservation } from "../domain/computer-observation.js";
import type { ComputerRuntimePort } from "../ports/computer-runtime-port.js";
export declare class ObserveComputerUseCase {
    private readonly runtime;
    constructor(runtime: ComputerRuntimePort);
    execute(signal?: AbortSignal): Promise<ComputerObservation>;
}
//# sourceMappingURL=observe-computer.d.ts.map