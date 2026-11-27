import type { AgentEvent } from "@agent/core";
import type { NativeJsonPacket } from "./native-stdio-channel.js";
import { type RuntimeQuestionAnswer } from "./types.js";
type Question = Omit<Extract<AgentEvent, {
    type: "ask_user";
}>, "type" | "questionId">;
export interface AcpQuestionCard {
    display: Question;
    answer(input: RuntimeQuestionAnswer): {
        value: unknown;
        text: string;
    } | undefined;
}
interface AcpQuestionRequest {
    cards: AcpQuestionCard[];
    cancel: NativeJsonPacket;
    reply(answers: Array<unknown>): NativeJsonPacket;
}
export declare function readAcpQuestion(agent: "grok" | "agy", method: string, params: NativeJsonPacket): AcpQuestionRequest | undefined;
export {};
//# sourceMappingURL=acp-questions.d.ts.map