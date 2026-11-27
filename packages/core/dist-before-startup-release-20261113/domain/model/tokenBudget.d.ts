import type { Message, ToolDefinition } from './entities.js';
/** Conservative fallback for mixed Chinese/English. */
export declare function estimateTextTokens(text: string): number;
export declare function estimateRequestTokens(messages: Message[], tools?: ToolDefinition[]): number;
export declare function truncateToTokenBudget(text: string, budget: number): string;
//# sourceMappingURL=tokenBudget.d.ts.map