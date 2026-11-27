export declare const WEBAPP_PROJECT_REQUEST_TYPE = "agent-webapp:project-request:v1";
export declare const WEBAPP_PROJECT_RESPONSE_TYPE = "agent-web-shell:project-response:v1";
export declare const WEB_PROJECT_METHODS: readonly ["project:list", "project:get", "project:create", "project:rename", "project:delete", "project:roots", "project:directories", "project:check"];
export type WebProjectMethod = typeof WEB_PROJECT_METHODS[number];
export type WebShellMethod = WebProjectMethod | "fs:preview-open" | "fs:preview-close";
export interface WebProjectRequest {
    type: typeof WEBAPP_PROJECT_REQUEST_TYPE;
    id: number;
    method: WebShellMethod;
    payload: Record<string, unknown>;
}
export interface WebProjectResponse {
    type: typeof WEBAPP_PROJECT_RESPONSE_TYPE;
    id: number;
    ok: boolean;
    result?: unknown;
    error?: string;
    code?: string;
}
export declare function parseWebProjectRequest(data: unknown): WebProjectRequest | null;
export declare function readWebProjectRequest(event: Pick<MessageEvent, "data" | "origin" | "source">, expectedOrigin: string, expectedSource: MessageEventSource | null): WebProjectRequest | null;
export declare function parseWebProjectResponse(data: unknown): WebProjectResponse | null;
//# sourceMappingURL=WebProjectBridge.d.ts.map