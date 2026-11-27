import type { AhpTransport, TransportFrame } from "@microsoft/agent-host-protocol/client";
import type { VSCodeAgentEndpoint } from "./copilot-vscode-discovery.js";
/** AHP's standard WS transport cannot address Unix sockets / Windows named pipes. */
export declare class VSCodeSocketTransport implements AhpTransport {
    private readonly socket;
    private readonly frames;
    private readonly iterator;
    private failed;
    private constructor();
    static open(endpoint: VSCodeAgentEndpoint): Promise<VSCodeSocketTransport>;
    send(message: Parameters<AhpTransport["send"]>[0]): void;
    recv(): Promise<TransportFrame | null>;
    close(): void;
}
//# sourceMappingURL=copilot-ahp-transport.d.ts.map