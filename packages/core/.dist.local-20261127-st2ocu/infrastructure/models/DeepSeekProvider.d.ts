import type { IModelProvider, Message, StreamEvent, StreamOptions, ModelProviderConfig } from '../../domain/model/entities.js';
export declare class DeepSeekProvider implements IModelProvider {
    readonly providerId = "deepseek";
    readonly modelId: string;
    private readonly apiKey;
    private readonly baseUrl;
    private readonly defaultMaxTokens;
    private readonly defaultTemperature;
    private readonly timeoutMs;
    constructor(config: ModelProviderConfig);
    streamChat(messages: Message[], options?: StreamOptions): AsyncIterable<StreamEvent>;
    countTokens(messages: Message[]): Promise<number>;
    supportsModel(_modelId: string): boolean;
    private stringContent;
    private adaptMessage;
}
//# sourceMappingURL=DeepSeekProvider.d.ts.map