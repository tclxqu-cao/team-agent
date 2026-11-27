import { type Socket } from "node:net";
import { type ComputerAction } from "../domain/computer-action.js";
import { type ComputerObservation } from "../domain/computer-observation.js";
import type { ComputerRuntimePort, ComputerRuntimeStatus } from "../ports/computer-runtime-port.js";
type ConnectSocket = (path: string) => Socket;
export declare class ComputerRelayClient implements ComputerRuntimePort {
    private readonly options;
    constructor(options?: {
        socketPath?: string;
        timeoutMs?: number | null;
        connect?: ConnectSocket;
        exists?: (path: string) => boolean;
    });
    status(signal?: AbortSignal): Promise<ComputerRuntimeStatus>;
    execute(action: ComputerAction, signal?: AbortSignal): Promise<ComputerObservation>;
    private request;
}
export {};
//# sourceMappingURL=relay-client.d.ts.map