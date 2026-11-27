import type { Session } from "./entities.js";
export declare const NEW_SESSION_PLACEHOLDER_TITLE = "\u65B0\u4F1A\u8BDD";
export declare const AUTO_TITLE_PENDING_METADATA_KEY = "autoTitleFromFirstMessage";
export declare function withPendingAutoTitle(title: string, metadata: Record<string, unknown>): Record<string, unknown>;
export declare function consumePendingAutoTitle(session: Pick<Session, "metadata">, input: string): {
    title: string;
    metadata: Record<string, unknown>;
} | null;
//# sourceMappingURL=SessionTitle.d.ts.map