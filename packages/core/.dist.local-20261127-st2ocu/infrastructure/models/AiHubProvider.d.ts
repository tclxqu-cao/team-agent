import type { IModelProvider, Message, StreamEvent, StreamOptions, ModelProviderConfig, ToolCall, ToolDefinition } from '../../domain/model/entities.js';
import type { AiHubCaptureMessage } from '../../domain/ai-hub/transport.js';
export declare function composeAiHubTranscript(messages: Message[], anchor: string, tools?: ToolDefinition[], workingDirectory?: string, includeToolProtocol?: boolean): string;
export declare class AiHubProvider implements IModelProvider {
    readonly providerId = "aihub";
    /** AI Hub 站点 ID（如 deepseek / chatgpt / 自定义站点） */
    readonly modelId: string;
    private readonly transport;
    private readonly timeoutMs;
    constructor(config: ModelProviderConfig);
    streamChat(messages: Message[], options?: StreamOptions): AsyncIterable<StreamEvent>;
    countTokens(messages: Message[]): Promise<number>;
    supportsModel(_modelId: string): boolean;
    private captureSite;
    /** 请桌面端点击站点上的「继续生成」控件；返回是否确认点击成功。 */
    private tryContinue;
    private continueLimitError;
}
/**
 * AI Hub pages already retain their own conversation. Bootstrap an empty page
 * with full CA context, then send only the new user turn or current tool-loop
 * delta so prior history is not nested again on every request.
 */
export declare function selectAiHubRelayMessages(messages: Message[], pageHasHistory: boolean, previousMessageCount?: number): Message[];
/** Remove code-block chrome exposed by webpage innerText (language / copy / download). */
export declare function stripCapturedCodeToolbar(text: string): string;
export declare function parseAiHubToolCall(reply: string, tools: ToolDefinition[]): ToolCall | null;
export declare function extractReplyAfterAnchor(messages: AiHubCaptureMessage[], anchorHead: string): string;
export declare function extractReplyAfterBaseline(messages: AiHubCaptureMessage[], baselineAssistantTexts: string[]): string;
//# sourceMappingURL=AiHubProvider.d.ts.map