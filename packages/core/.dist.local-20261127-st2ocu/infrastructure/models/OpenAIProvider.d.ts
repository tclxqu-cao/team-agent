import type { IModelProvider, Message, StreamEvent, StreamOptions, ModelProviderConfig } from '../../domain/model/entities.js';
import type { ToolDefinition } from '../../domain/model/entities.js';
export declare class OpenAIProvider implements IModelProvider {
    readonly providerId = "openai";
    readonly modelId: string;
    private readonly apiKey;
    private readonly baseUrl;
    private readonly defaultMaxTokens;
    private readonly defaultTemperature;
    private readonly timeoutMs;
    private localContext?;
    constructor(config: ModelProviderConfig);
    streamChat(messages: Message[], options?: StreamOptions): AsyncIterable<StreamEvent>;
    countTokens(messages: Message[]): Promise<number>;
    getContextWindow(): Promise<number | undefined>;
    private discoverLocalContext;
    countRequestTokens(messages: Message[], tools?: ToolDefinition[]): Promise<number>;
    supportsModel(modelId: string): boolean;
    private stringContent;
    private adaptMessage;
}
//# sourceMappingURL=OpenAIProvider.d.ts.map