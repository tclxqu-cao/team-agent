export declare const COLLABORATION_CHANGED_TYPE = "agent-webapp:collaboration-changed:v1";
export declare const COLLABORATION_OPEN_TYPE = "agent-webapp:collaboration-open:v1";
export declare const COLLABORATION_CONTENT_READY_TYPE = "agent-webapp:collaboration-content-ready:v1";
export declare const COLLABORATION_DASHBOARD_READY_TYPE = "agent-webapp:collaboration-dashboard-ready:v1";
export declare const COLLABORATION_CREATE_TYPE = "agent-web-shell:collaboration-create:v1";
export declare function readCollaborationCreate(event: Pick<MessageEvent, "data" | "source" | "origin">, origin: string, parent: MessageEventSource | null): boolean;
export declare function readCollaborationOpen(event: Pick<MessageEvent, "data" | "source" | "origin">, origin: string, source: MessageEventSource | null): {
    groupId: string;
    title: string;
} | null;
/** Only the dashboard frame may report completed group mutations. */
export declare function readCollaborationChanged(event: Pick<MessageEvent, "data" | "source" | "origin">, origin: string, source: MessageEventSource | null): {
    groupId: string;
    title?: string;
    deleted?: true;
} | null;
/** Readiness belongs to the current view's frame, not the iframe document load event. */
export declare function readCollaborationContentReady(event: Pick<MessageEvent, "data" | "source" | "origin">, origin: string, source: MessageEventSource | null, groupId: string | null): boolean;
//# sourceMappingURL=CollaborationTabBridge.d.ts.map