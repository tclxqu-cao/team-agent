import type { IMCPClient, MCPServerConfig, MCPTool, MCPResource } from './entities.js';
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export class MCPClient implements IMCPClient {
  readonly serverId: string;
  private process: ChildProcess | null = null;
  private requestId = 0;
  private pendingRequests = new Map<number, (res: JsonRpcResponse) => void>();
  private _connected = false;
  private config: MCPServerConfig | null = null;
  private toolCache: MCPTool[] = [];

  constructor(serverId: string) {
    this.serverId = serverId;
  }

  get connected(): boolean {
    return this._connected && this.process?.exitCode === null;
  }

  async connect(config: MCPServerConfig): Promise<void> {
    this.config = config;

    if (config.transport === "stdio") {
      return this.connectStdio(config);
    }
    throw new Error(`Transport "${config.transport}" not supported yet`);
  }

  private connectStdio(config: MCPServerConfig): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(config.command, config.args, {
        env: { ...process.env, ...config.env },
        stdio: ["pipe", "pipe", "pipe"],
      });

      this.process = proc;

      const rl = createInterface({ input: proc.stdout! });

      rl.on("line", (line: string) => {
        try {
          const response: JsonRpcResponse = JSON.parse(line);
          const pending = this.pendingRequests.get(response.id);
          if (pending) {
            pending(response);
            this.pendingRequests.delete(response.id);
          }
        } catch {
          // non-JSON line (stderr, etc.)
        }
      });

      proc.stderr?.on("data", (data: Buffer) => {
        // log stderr from MCP server
        console.error(`[MCP ${this.serverId}] ${data.toString().trim()}`);
      });

      proc.on("exit", (code) => {
        this._connected = false;
        if (code !== 0 && this.pendingRequests.size > 0) {
          for (const [, reject] of this.pendingRequests) {
            reject({ jsonrpc: "2.0", id: 0, error: { code: -1, message: `Process exited with code ${code}` } });
          }
          this.pendingRequests.clear();
        }
      });

      proc.on("error", (err) => {
        this._connected = false;
        reject(err);
      });

      // Send initialize request
      this.sendRequest("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {}, resources: {} },
        clientInfo: { name: "customer-agent", version: "0.1.0" },
      })
        .then(() => {
          this._connected = true;
          resolve();
        })
        .catch(reject);
    });
  }

  disconnect(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this._connected = false;
    this.toolCache = [];
  }

  async listTools(): Promise<MCPTool[]> {
    const result = await this.sendRequest("tools/list", {});
    const tools = (result as { tools?: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> }).tools ?? [];
    this.toolCache = tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    }));
    return this.toolCache;
  }

  async listResources(): Promise<MCPResource[]> {
    const result = await this.sendRequest("resources/list", {});
    const resources = (result as { resources?: Array<{ uri: string; name: string; description?: string; mimeType?: string }> }).resources ?? [];
    return resources.map((r) => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
      mimeType: r.mimeType,
    }));
  }

  async callTool(name: string, args: unknown): Promise<unknown> {
    return this.sendRequest("tools/call", { name, arguments: args });
  }

  async readResource(uri: string): Promise<unknown> {
    return this.sendRequest("resources/read", { uri });
  }

  private sendRequest(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.process || !this.process.stdin) {
        reject(new Error("MCP client not connected"));
        return;
      }

      const id = ++this.requestId;
      const request: JsonRpcRequest = {
        jsonrpc: "2.0",
        id,
        method,
        params,
      };

      this.pendingRequests.set(id, (response) => {
        if (response.error) {
          reject(new Error(response.error.message));
        } else {
          resolve(response.result);
        }
      });

      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`MCP request ${method} timed out`));
      }, 30000);

      // Remove the timeout on resolution
      const originalPending = this.pendingRequests.get(id);
      this.pendingRequests.set(id, (response) => {
        clearTimeout(timeout);
        if (originalPending) originalPending(response);
      });

      this.process.stdin.write(JSON.stringify(request) + "\n");
    });
  }
}
