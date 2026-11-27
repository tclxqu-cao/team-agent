import type { AgentEvent } from "@agent/core";
import type { CodexDesktopConnection } from "./codex-desktop-tools.js";
import type { RuntimeRunOptions } from "./types.js";
/** One human send, followed through the original Desktop-owned thread. */
export declare class CodexDesktopContinuation {
    private readonly connection;
    private readonly pollMs;
    private sent;
    private readonly controller;
    constructor(connection: CodexDesktopConnection, pollMs?: number);
    close(): void;
    run(input: string, options?: RuntimeRunOptions): AsyncIterable<AgentEvent>;
}
//# sourceMappingURL=codex-desktop-continuation.d.ts.map