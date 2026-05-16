// ── MCP Domain ──

export interface MCPServerConfig {
  id: string;
  name: string;
  transport: "stdio" | "sse" | "streamableHttp";
  // stdio fields
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // sse/remote fields
  url?: string;
  sseUrl?: string; // alias for url, kept for backward compat
  // custom HTTP headers (streamableHttp / authenticated SSE)
  headers?: Record<string, string>;
}

export interface MCPTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface IMCPClient {
  readonly serverId: string;
  readonly connected: boolean;

  connect(config: MCPServerConfig): Promise<void>;
  disconnect(): void;
  listTools(): Promise<MCPTool[]>;
  listResources(): Promise<MCPResource[]>;
  callTool(name: string, args: unknown): Promise<unknown>;
  readResource(uri: string): Promise<unknown>;
}

export interface IMCPManager {
  connectServer(config: MCPServerConfig): Promise<IMCPClient>;
  disconnectServer(serverId: string): Promise<void>;
  getClient(serverId: string): IMCPClient | undefined;
  listServers(): MCPServerConfig[];
  discoverAllTools(): Promise<Map<string, MCPTool[]>>;
}
