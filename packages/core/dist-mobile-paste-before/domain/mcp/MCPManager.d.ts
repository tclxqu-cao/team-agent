import type { IMCPManager, IMCPClient, MCPServerConfig, MCPTool } from './entities.js';
import type { IToolRegistry } from '../tool/entities.js';
export declare class MCPManager implements IMCPManager {
    private readonly toolRegistry?;
    private readonly clients;
    constructor(toolRegistry?: IToolRegistry | undefined);
    connectServer(config: MCPServerConfig): Promise<IMCPClient>;
    disconnectServer(serverId: string): Promise<void>;
    getClient(serverId: string): IMCPClient | undefined;
    listServers(): MCPServerConfig[];
    discoverAllTools(): Promise<Map<string, MCPTool[]>>;
    private registerMCPTools;
}
//# sourceMappingURL=MCPManager.d.ts.map