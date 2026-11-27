import type { ComputerAction } from "../domain/computer-action.js";
import type { ComputerErrorCode, ComputerObservation } from "../domain/computer-observation.js";
import type { ComputerRuntimeStatus } from "../ports/computer-runtime-port.js";
export declare const COMPUTER_RELAY_PROTOCOL_VERSION = 1;
export declare const COMPUTER_RELAY_SOCKET_NAME = "computer-relay.sock";
export declare const COMPUTER_RELAY_REQUEST_LIMIT: number;
export declare const COMPUTER_RELAY_RESPONSE_LIMIT: number;
export declare const COMPUTER_RELAY_TIMEOUT_MS = 8000;
export type ComputerRelayRequest = {
    id: string;
    version: number;
    type: "status";
} | {
    id: string;
    version: number;
    type: "execute";
    action: ComputerAction;
};
export type ComputerRelayResponse = {
    id: string;
    ok: true;
    result: ComputerRuntimeStatus | ComputerObservation;
} | {
    id: string;
    ok: false;
    error: {
        code: ComputerErrorCode;
        message: string;
        recovery?: string;
    };
};
export declare function resolveComputerRelayDirectory(env?: NodeJS.ProcessEnv): string;
export declare function resolveComputerRelaySocketPath(env?: NodeJS.ProcessEnv): string;
//# sourceMappingURL=relay-protocol.d.ts.map