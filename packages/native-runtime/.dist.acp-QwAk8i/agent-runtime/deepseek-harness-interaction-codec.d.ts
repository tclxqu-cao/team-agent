import type { AgentEvent } from "@agent/core";
import { type HarnessRecord } from "./deepseek-harness-client.js";
import { type RuntimeQuestionAnswer } from "./types.js";
export interface HarnessQuestion {
    id: string;
    question: string;
    detail?: string;
    header?: string;
    options?: Array<{
        label: string;
        description: string;
    }>;
    multiSelect?: boolean;
}
export interface HarnessQuestionRef {
    sessionId: string;
    kind: "question" | "approval";
    requestId: string;
    itemId: string;
}
export interface HarnessAnswerItem {
    id: string;
    selected: string[];
    custom?: string;
}
/** Opaque identities route answers to their native session, including after a broker restart. */
export declare function harnessQuestionId(ref: HarnessQuestionRef): string;
export declare function parseHarnessQuestionId(value: string): HarnessQuestionRef | null;
export declare function decodeHarnessQuestions(value: unknown): HarnessQuestion[];
export declare function harnessAskEvent(ref: HarnessQuestionRef, question: HarnessQuestion): AgentEvent;
export declare function harnessAnswer(question: HarnessQuestion, answer: RuntimeQuestionAnswer): HarnessAnswerItem;
export declare function harnessQuestionProjection(row: HarnessRecord): HarnessRecord;
//# sourceMappingURL=deepseek-harness-interaction-codec.d.ts.map