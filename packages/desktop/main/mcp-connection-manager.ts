import {
  MCPManager,
  type ToolRegistry,
} from "@agent/core";
import type { SQLiteMCPServerStore } from "@agent/core";

/**
 * Manages MCP server connections lifecycle.
 * Extracted from AgentHost to separate connection management concerns.
 */
export class MCPConnectionManager {
  private mcpManager: MCPManager | null = null;

  constructor(private readonly mcpStore: SQLiteMCPServerStore) {}

  /**
   * Connect all enabled MCP servers and register their tools into the given registry.
   * Disconnects any previously connected servers first to avoid duplicates.
   */
  async connectServers(toolRegistry: ToolRegistry): Promise<void> {
    // Disconnect previous manager cleanly
    if (this.mcpManager) {
      for (const cfg of this.mcpManager.listServers()) {
        await this.mcpManager.disconnectServer(cfg.id).catch(() => {});
      }
      this.mcpManager = null;
    }

    const enabledServers = await this.mcpStore.list(); // only enabled ones
    if (enabledServers.length === 0) return;

    this.mcpManager = new MCPManager(toolRegistry);

    for (const cfg of enabledServers) {
      try {
        await this.mcpManager.connectServer(cfg);
        console.log(`[MCP] Connected: ${cfg.id} (${cfg.transport})`);
      } catch (err) {
        console.error(`[MCP] Failed to connect ${cfg.id}:`, err);
      }
    }
  }

  /**
   * Temporarily connect to an MCP server, list its tools, then disconnect.
   * Returns tool name + description pairs without touching the main toolRegistry.
   */
  async probeServerTools(
    config: Parameters<typeof MCPManager.prototype.connectServer>[0],
  ): Promise<Array<{ name: string; description: string }>> {
    const mgr = new MCPManager(); // no registry — pure probe
    try {
      const client = await mgr.connectServer(config);
      const tools = await client.listTools();
      return tools.map((t) => ({ name: t.name, description: t.description }));
    } finally {
      await mgr.disconnectServer(config.id).catch(() => {});
    }
  }

  /** Disconnect all currently connected servers */
  async disconnectAll(): Promise<void> {
    if (!this.mcpManager) return;
    for (const cfg of this.mcpManager.listServers()) {
      await this.mcpManager.disconnectServer(cfg.id).catch(() => {});
    }
    this.mcpManager = null;
  }

  /** Get the current MCP manager (may be null if not connected) */
  getManager(): MCPManager | null {
    return this.mcpManager;
  }
}
