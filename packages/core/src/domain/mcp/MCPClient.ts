import type { IMCPClient, MCPServerConfig, MCPTool, MCPResource } from './entities.js';
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import http from "node:http";
import https from "node:https";
import { IncomingMessage } from "node:http";

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
  // SSE transport state
  private ssePostUrl: string | null = null;
  private sseRes: IncomingMessage | null = null;

  constructor(serverId: string) {
    this.serverId = serverId;
  }

  get connected(): boolean {
    if (this.config?.transport === "sse") return this._connected;
    return this._connected && this.process?.exitCode === null;
  }

  async connect(config: MCPServerConfig): Promise<void> {
    this.config = config;
    if (config.transport === "stdio") {
      return this.connectStdio(config);
    }
    if (config.transport === "sse") {
      return this.connectSSE(config);
    }
    throw new Error(`Transport "${config.transport}" not supported`);
  }

  private connectStdio(config: MCPServerConfig): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(config.command!, config.args ?? [], {
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
    if (this.sseRes) {
      this.sseRes.destroy();
      this.sseRes = null;
    }
    this.ssePostUrl = null;
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
    if (this.config?.transport === "sse") {
      return this.sendRequestSSE(method, params);
    }
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

  /** Send a JSON-RPC request via HTTP POST to the SSE server's message endpoint. */
  private sendRequestSSE(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ssePostUrl) {
        reject(new Error("SSE post URL not established"));
        return;
      }
      const id = ++this.requestId;
      const body = JSON.stringify({ jsonrpc: "2.0", id, method, params } as JsonRpcRequest);
      const postUrl = new URL(this.ssePostUrl);
      const proto = postUrl.protocol === "https:" ? https : http;

      this.pendingRequests.set(id, (response) => {
        if (response.error) reject(new Error(response.error.message));
        else resolve(response.result);
      });

      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`MCP SSE request ${method} timed out`));
      }, 30000);
      const orig = this.pendingRequests.get(id)!;
      this.pendingRequests.set(id, (response) => { clearTimeout(timeout); orig(response); });

      const req = proto.request(postUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      }, (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          // Some servers respond directly with JSON-RPC response instead of via SSE
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300 && data.trim()) {
            try {
              const response: JsonRpcResponse = JSON.parse(data);
              const pending = this.pendingRequests.get(response.id);
              if (pending) { pending(response); this.pendingRequests.delete(response.id); }
            } catch { /* response will come via SSE */ }
          }
        });
      });
      req.on("error", (err) => {
        this.pendingRequests.delete(id);
        clearTimeout(timeout);
        reject(err);
      });
      req.write(body);
      req.end();
    });
  }

  /**
   * Connect using SSE transport (MCP over HTTP+SSE).
   * 1. GET {url} with Accept: text/event-stream → receive "endpoint" event with POST path
   * 2. POST JSON-RPC requests to the message endpoint
   * 3. Receive responses via SSE "message" events
   */
  private connectSSE(config: MCPServerConfig): Promise<void> {
    return new Promise((resolve, reject) => {
      const sseUrl = (config.url ?? config.sseUrl)!;
      if (!sseUrl) { reject(new Error("SSE URL is required for remote MCP servers")); return; }

      const parsedUrl = new URL(sseUrl);
      const proto = parsedUrl.protocol === "https:" ? https : http;

      const req = proto.get(sseUrl, { headers: { Accept: "text/event-stream", "Cache-Control": "no-cache" } }, (res) => {
        this.sseRes = res;
        let buffer = "";
        let eventType = "";
        let data = "";
        let initialized = false;

        res.on("data", (chunk: Buffer) => {
          buffer += chunk.toString();
          const lines = buffer.split("\n");
          buffer = lines.pop()!;

          for (const line of lines) {
            if (line.startsWith("event:")) {
              eventType = line.slice(6).trim();
            } else if (line.startsWith("data:")) {
              data = line.slice(5).trim();
            } else if (line === "" && (eventType || data)) {
              if (eventType === "endpoint") {
                // Build the full POST URL from the base SSE URL
                try {
                  this.ssePostUrl = new URL(data, `${parsedUrl.protocol}//${parsedUrl.host}`).toString();
                } catch {
                  this.ssePostUrl = data;
                }
                if (!initialized) {
                  initialized = true;
                  this.sendRequestSSE("initialize", {
                    protocolVersion: "2024-11-05",
                    capabilities: { tools: {}, resources: {} },
                    clientInfo: { name: "customer-agent", version: "0.1.0" },
                  }).then(() => {
                    this._connected = true;
                    resolve();
                  }).catch(reject);
                }
              } else if (eventType === "message" || eventType === "") {
                try {
                  const response: JsonRpcResponse = JSON.parse(data);
                  const pending = this.pendingRequests.get(response.id);
                  if (pending) { pending(response); this.pendingRequests.delete(response.id); }
                } catch { /* ignore non-JSON */ }
              }
              eventType = "";
              data = "";
            }
          }
        });

        res.on("error", (err) => { this._connected = false; reject(err); });
        res.on("end", () => { this._connected = false; });
      });

      req.on("error", reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error("SSE connection timed out")); });
    });
  }
}
