import type { SystemPromptSections } from '../context/entities.js';
import type { Message, ToolDefinition } from '../model/entities.js';
import type { ContextUsageSnapshot } from './entities.js';
export interface EstimateContextUsageInput {
    requestIndex: number;
    providerId: string;
    modelId: string;
    maxTokens: number;
    messages: Message[];
    currentUserMessage: Message;
    nativeToolDefinitions: ToolDefinition[];
    systemSections: SystemPromptSections;
}
export declare function estimateContextUsage(input: EstimateContextUsageInput): ContextUsageSnapshot;
//# sourceMappingURL=ContextUsageEstimator.d.ts.map