import type { IMCPManager, IMCPClient, MCPServerConfig, MCPTool } from './entities.js';
import type { IToolRegistry, ITool } from '../tool/entities.js';
import { MCPClient } from './MCPClient.js';
import { z } from "zod";

export class MCPManager implements IMCPManager {
  private readonly clients = new Map<string, IMCPClient>();

  constructor(private readonly toolRegistry?: IToolRegistry) {}

  async connectServer(config: MCPServerConfig): Promise<IMCPClient> {
    const client = new MCPClient(config.id);
    await client.connect(config);
    this.clients.set(config.id, client);

    if (this.toolRegistry) {
      await this.registerMCPTools(client);
    }

    return client;
  }

  async disconnectServer(serverId: string): Promise<void> {
    const client = this.clients.get(serverId);
    if (client) {
      // Unregister tools from this server
      if (this.toolRegistry) {
        const tools = await client.listTools().catch(() => []);
        for (const tool of tools) {
          this.toolRegistry.unregister(`mcp_${serverId}_${tool.name}`);
        }
      }
      client.disconnect();
      this.clients.delete(serverId);
    }
  }

  getClient(serverId: string): IMCPClient | undefined {
    return this.clients.get(serverId);
  }

  listServers(): MCPServerConfig[] {
    return Array.from(this.clients.values()).map((c) => ({
      id: c.serverId,
      name: c.serverId,
      command: "",
      args: [],
      transport: "stdio" as const,
    }));
  }

  async discoverAllTools(): Promise<Map<string, MCPTool[]>> {
    const result = new Map<string, MCPTool[]>();
    for (const [id, client] of this.clients) {
      try {
        const tools = await client.listTools();
        result.set(id, tools);
      } catch {
        result.set(id, []);
      }
    }
    return result;
  }

  private async registerMCPTools(client: IMCPClient): Promise<void> {
    const tools = await client.listTools();
    for (const mcpTool of tools) {
      const toolName = `mcp_${client.serverId}_${mcpTool.name}`;
      const mcpToolAdapter: ITool = {
        name: toolName,
        description: `[MCP:${client.serverId}] ${mcpTool.description}`,
        parameters: mcpTool.parameters,
        schema: z.object({}).passthrough(),
        networkAccess: "unknown",
        execute: async (params) => {
          const result = await client.callTool(mcpTool.name, params);
          const content = typeof result === "string"
            ? result
            : (result as { content?: Array<{ type: string; text?: string }> }).content?.map((c) => c.text ?? "").join("\n") ?? JSON.stringify(result);
          return { toolCallId: "", content };
        },
      };
      this.toolRegistry?.register(mcpToolAdapter);
    }
  }
}
