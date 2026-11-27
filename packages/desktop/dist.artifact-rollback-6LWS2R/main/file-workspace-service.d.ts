import { type FileWorkspaceEvent, type FileWorkspaceMethod } from "@agent/core";
interface PreviewTicketState {
    path: string;
    mime: string;
    markdown: boolean;
    expiresAt: number;
}
export interface DesktopFileWorkspaceServiceOptions {
    roots: string[];
    home?: string;
    emit: (event: FileWorkspaceEvent) => void;
    now?: () => number;
    token?: () => string;
    ticketTtlMs?: number;
}
export declare function renderDesktopMarkdown(source: string, title: string): string;
export declare class DesktopFileWorkspaceService {
    private readonly policy;
    private readonly home;
    private readonly emit;
    private readonly now;
    private readonly token;
    private readonly ticketTtlMs;
    private readonly tickets;
    private readonly watchers;
    constructor(options: DesktopFileWorkspaceServiceOptions);
    request(method: FileWorkspaceMethod, params?: Record<string, unknown>): Promise<unknown>;
    resolvePreviewTicket(ticketId: string): PreviewTicketState | null;
    close(): void;
    private list;
    private read;
    private fileStat;
    private inspectTextStatus;
    private inspectText;
    private writeText;
    private watch;
    private unwatch;
    private unwatchCanonical;
    private openPreview;
    private revokePreview;
    private pruneTickets;
}
export declare function createDesktopPreviewResponse(service: DesktopFileWorkspaceService, request: Request): Promise<Response>;
export {};
//# sourceMappingURL=file-workspace-service.d.ts.map