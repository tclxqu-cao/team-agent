import { LSPClient } from './LSPClient.js';
import type { LSPServerConfig } from '../../domain/lsp/entities.js';
export declare class LSPManager {
    /** language → running LSPClient */
    private clients;
    /** Find the configured server whose fileTypes includes the given file extension. */
    configForFile(filePath: string, configs: LSPServerConfig[]): LSPServerConfig | null;
    /**
     * Return a running LSPClient for the given server config.
     * Starts the server if it isn't already running.
     */
    getClient(config: LSPServerConfig, workspaceRoot: string): Promise<LSPClient>;
    /** Shut down all running LSP clients. */
    shutdownAll(): Promise<void>;
}
//# sourceMappingURL=LSPManager.d.ts.map