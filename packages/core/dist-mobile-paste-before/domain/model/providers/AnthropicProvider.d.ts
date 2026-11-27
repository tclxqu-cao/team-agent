import type { IModelProvider, Message, StreamEvent, StreamOptions, ModelProviderConfig } from '../entities.js';
export declare class AnthropicProvider implements IModelProvider {
    readonly providerId = "anthropic";
    readonly modelId: string;
    private readonly apiKey;
    private readonly baseUrl;
    private readonly defaultMaxTokens;
    private readonly defaultTemperature;
    private readonly timeoutMs;
    constructor(config: ModelProviderConfig);
    streamChat(messages: Message[], options?: StreamOptions): AsyncIterable<StreamEvent>;
    countTokens(messages: Message[]): Promise<number>;
    supportsModel(modelId: string): boolean;
    private adaptMessage;
    private estimateTokens;
}
//# sourceMappingURL=AnthropicProvider.d.ts.map