import type { Message } from "../model/entities.js";
import type { SessionQueryIndex } from "./entities.js";
export declare class SessionQueryIndexCache {
    private readonly capacity;
    private readonly entries;
    constructor(capacity?: number);
    getOrCreate(sessionId: string, messages: readonly Message[]): SessionQueryIndex;
    invalidate(sessionId: string): void;
    clear(): void;
}
//# sourceMappingURL=SessionQueryIndexCache.d.ts.map