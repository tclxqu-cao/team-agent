export type OpenCodeRecord = Record<string, unknown>;
export declare function record(value: unknown): OpenCodeRecord;
export declare function array(value: unknown): unknown[];
export declare function errorText(value: unknown): string;
export declare function v2Session(value: unknown): OpenCodeRecord;
export declare function v2Tool(value: unknown, sessionID: string, messageID: string): OpenCodeRecord;
export declare function v2Message(value: unknown, sessionID: string): OpenCodeRecord | null;
export declare const OPENCODE_INTERRUPTED_EVENT = "agentroam:opencode-interrupted";
/** Keeps text/tool state only until the execution's authoritative terminal event. */
export declare class OpenCodeV2EventCodec {
    private readonly directories;
    private readonly text;
    private readonly tools;
    constructor(directories: Map<string, string>);
    convert(value: unknown): OpenCodeRecord[];
}
//# sourceMappingURL=opencode-v2-codec.d.ts.map