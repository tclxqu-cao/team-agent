import { type DesktopFileWorkspaceService } from "./file-workspace-service.js";
export declare class ArtifactBrowserPreview {
    private readonly workspace;
    private server;
    private origin;
    constructor(workspace: DesktopFileWorkspaceService);
    open(path: string, openExternal: (url: string) => Promise<void>): Promise<void>;
    close(): void;
    private listen;
    private serve;
}
//# sourceMappingURL=artifact-browser-preview.d.ts.map