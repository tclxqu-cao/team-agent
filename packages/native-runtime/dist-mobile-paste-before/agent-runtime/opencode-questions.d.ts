import type { AgentEvent } from "@agent/core";
export declare const OPENCODE_QUESTION_ASKED = "agentroam:opencode-question-asked";
export declare const OPENCODE_QUESTION_RESOLVED = "agentroam:opencode-question-resolved";
export interface OpenCodeQuestion {
    key: string;
    question: string;
    multiSelect: boolean;
    options: Array<{
        value: string;
        label: string;
        description: string;
    }>;
}
export interface OpenCodeQuestionRequest {
    id: string;
    sessionID: string;
    protocol: "form" | "question";
    questions: OpenCodeQuestion[];
}
export type OpenCodeQuestionEvent = {
    type: typeof OPENCODE_QUESTION_ASKED;
    properties: OpenCodeQuestionRequest;
} | {
    type: typeof OPENCODE_QUESTION_RESOLVED;
    properties: {
        sessionID: string;
        id: string;
    };
};
export interface OpenCodeQuestionClient {
    list(sessionID: string, directory: string): Promise<OpenCodeQuestionRequest[]>;
    reply(request: OpenCodeQuestionRequest, answers: string[][], directory: string): Promise<void>;
}
/** OpenCode 2's question tool uses Form; generic forms are outside this port. */
export declare function openCodeFormQuestion(value: unknown): OpenCodeQuestionRequest | null;
/** OpenCode 1 exposes the question request directly rather than a Form. */
export declare function openCodeLegacyQuestion(value: unknown): OpenCodeQuestionRequest;
export declare function openCodeQuestionId(request: OpenCodeQuestionRequest, index: number): string;
export declare function isOpenCodeQuestionId(id: string): boolean;
export declare function openCodeQuestionCard(request: OpenCodeQuestionRequest, index: number): Extract<AgentEvent, {
    type: "ask_user";
}>;
export declare function createOpenCodeQuestionClient(baseUrl: string, protocol: "form" | "question", authorization?: string, fetchRequest?: typeof fetch): OpenCodeQuestionClient;
//# sourceMappingURL=opencode-questions.d.ts.map