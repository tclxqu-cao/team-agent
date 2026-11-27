import { MCPManager, type ToolRegistry } from "@agent/core";
import type { SQLiteMCPServerStore } from "@agent/core";
/**
 * Manages MCP server connections lifecycle.
 * Extracted from AgentHost to separate connection management concerns.
 */
export declare class MCPConnectionManager {
    private readonly mcpStore;
    private mcpManager;
    constructor(mcpStore: SQLiteMCPServerStore);
    /**
     * Connect all enabled MCP servers and register their tools into the given registry.
     * Disconnects any previously connected servers first to avoid duplicates.
     */
    connectServers(toolRegistry: ToolRegistry): Promise<void>;
    /**
     * Temporarily connect to an MCP server, list its tools, then disconnect.
     * Returns tool name + description pairs without touching the main toolRegistry.
     */
    probeServerTools(config: Parameters<typeof MCPManager.prototype.connectServer>[0]): Promise<Array<{
        name: string;
        description: string;
    }>>;
    /** Disconnect all currently connected servers */
    disconnectAll(): Promise<void>;
    /** Get the current MCP manager (may be null if not connected) */
    getManager(): MCPManager | null;
}
//# sourceMappingURL=mcp-connection-manager.d.ts.map