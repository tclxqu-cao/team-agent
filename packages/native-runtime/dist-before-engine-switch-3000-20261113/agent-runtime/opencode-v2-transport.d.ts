import { type OpencodeClient } from "@opencode-ai/sdk";
import { type OpenCodeQuestionClient } from "./opencode-questions.js";
export type OpenCodeRuntimeClient = OpencodeClient & {
    questions?: OpenCodeQuestionClient;
};
export declare function createOpenCodeV2Client(baseUrl: string, authorization: string, request?: typeof fetch): OpenCodeRuntimeClient;
export declare function createOpenCodeV2Fetch(baseUrl: string, authorization: string, request?: typeof fetch): typeof fetch;
//# sourceMappingURL=opencode-v2-transport.d.ts.map