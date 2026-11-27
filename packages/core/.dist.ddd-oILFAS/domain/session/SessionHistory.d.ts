import type { AgentEvent } from "../agent/entities.js";
import type { Message } from "../model/entities.js";
import type { SessionHistoryPage, SessionHistoryQuery } from "./entities.js";
export declare const DEFAULT_SESSION_HISTORY_PAGE_SIZE = 50;
export declare const MAX_SESSION_HISTORY_PAGE_SIZE = 100;
/**
 * Pages history by visible timeline item rather than raw message row. Tool
 * results stay beside their assistant tool call and do not consume a page slot.
 */
export declare function paginateSessionHistory(messages: Message[], events: AgentEvent[], query?: SessionHistoryQuery, options?: {
    includePendingQuestions?: boolean;
    preserveHistoryIds?: boolean;
}): SessionHistoryPage;
//# sourceMappingURL=SessionHistory.d.ts.map