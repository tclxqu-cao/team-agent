export declare const WEBAPP_ARTIFACT_OPEN_TYPE = "agent-webapp:artifact-open:v1";
export interface WebArtifactOpenRequest {
    type: typeof WEBAPP_ARTIFACT_OPEN_TYPE;
    requestId: number;
    path: string;
    revealOnly?: true;
}
/** Remote media stays in the browser; it is never fetched by the host file service. */
export declare function isWebMediaUrl(value: string): boolean;
export declare function parseWebArtifactOpenRequest(data: unknown): WebArtifactOpenRequest | null;
export declare function readWebArtifactOpenRequest(event: Pick<MessageEvent, "data" | "origin" | "source">, expectedOrigin: string, expectedSource: MessageEventSource | null): WebArtifactOpenRequest | null;
//# sourceMappingURL=WebArtifactBridge.d.ts.map