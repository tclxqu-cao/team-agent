// ── LSP JSON-RPC Client (stdio transport) ──
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { LSPServerConfig, LSPDiagnostic, LSPHoverResult, LSPLocation } from './entities.js';

interface JSONRPCMessage {
  jsonrpc: '2.0';
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class LSPClient extends EventEmitter {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buffer = '';
  private diagnosticsMap = new Map<string, LSPDiagnostic[]>();
  private _isRunning = false;

  constructor(private readonly config: LSPServerConfig) {
    super();
  }

  get isRunning(): boolean { return this._isRunning; }

  async start(workspaceRoot: string): Promise<void> {
    this.proc = spawn(this.config.command, this.config.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.config.env },
      cwd: workspaceRoot,
    });

    this.proc.on('exit', () => { this._isRunning = false; });

    this.proc.stdout!.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf-8');
      this.flushBuffer();
    });

    // stderr is purely informational for LSP servers
    this.proc.stderr!.on('data', () => { /* ignore */ });

    await this.initialize(workspaceRoot);
    this._isRunning = true;
  }

  private flushBuffer(): void {
    while (true) {
      const sep = this.buffer.indexOf('\r\n\r\n');
      if (sep === -1) break;
      const header = this.buffer.slice(0, sep);
      const m = header.match(/Content-Length:\s*(\d+)/i);
      if (!m) { this.buffer = ''; break; }
      const len = parseInt(m[1], 10);
      const bodyStart = sep + 4;
      if (this.buffer.length < bodyStart + len) break;
      const body = this.buffer.slice(bodyStart, bodyStart + len);
      this.buffer = this.buffer.slice(bodyStart + len);
      try { this.dispatch(JSON.parse(body) as JSONRPCMessage); } catch { /* ignore */ }
    }
  }

  private dispatch(msg: JSONRPCMessage): void {
    if (msg.id !== undefined && ('result' in msg || 'error' in msg)) {
      // Response to a request
      const p = this.pending.get(msg.id!);
      if (p) {
        this.pending.delete(msg.id!);
        if (msg.error) p.reject(new Error(`LSP ${msg.error.code}: ${msg.error.message}`));
        else p.resolve(msg.result);
      }
    } else if (msg.method) {
      // Notification from server
      if (msg.method === 'textDocument/publishDiagnostics') {
        const p = msg.params as { uri: string; diagnostics: LSPDiagnostic[] };
        this.diagnosticsMap.set(p.uri, p.diagnostics);
        this.emit('diagnostics', p);
      }
    }
  }

  private write(msg: Omit<JSONRPCMessage, 'jsonrpc'>): void {
    const body = JSON.stringify({ jsonrpc: '2.0', ...msg });
    const header = `Content-Length: ${Buffer.byteLength(body, 'utf-8')}\r\n\r\n`;
    this.proc?.stdin?.write(header + body);
  }

  private request<T>(method: string, params: unknown, timeoutMs = 10_000): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      this.write({ id, method, params });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`LSP timeout: ${method}`));
        }
      }, timeoutMs);
    });
  }

  private notify(method: string, params?: unknown): void {
    this.write({ method, params });
  }

  private async initialize(rootPath: string): Promise<void> {
    const rootUri = pathToFileURL(rootPath).toString();
    await this.request('initialize', {
      processId: process.pid,
      clientInfo: { name: 'customer-agent', version: '1.0.0' },
      rootUri,
      capabilities: {
        textDocument: {
          hover: { contentFormat: ['markdown', 'plaintext'] },
          definition: { linkSupport: false },
          references: {},
          publishDiagnostics: { relatedInformation: true },
          diagnostic: { dynamicRegistration: false },
        },
        workspace: { workspaceFolders: true },
      },
      workspaceFolders: [{ uri: rootUri, name: rootPath.split('/').pop() ?? 'root' }],
    });
    this.notify('initialized', {});
  }

  /** Open a file so the LSP server knows about it. Reads from disk. */
  openDocument(filePath: string): void {
    const uri = pathToFileURL(filePath).toString();
    let text = '';
    try { text = readFileSync(filePath, 'utf-8'); } catch { return; }
    this.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: this.config.language, version: 1, text },
    });
  }

  closeDocument(filePath: string): void {
    const uri = pathToFileURL(filePath).toString();
    this.notify('textDocument/didClose', { textDocument: { uri } });
  }

  /** Get diagnostics (errors/warnings) for a file. */
  async getDiagnostics(filePath: string): Promise<LSPDiagnostic[]> {
    const uri = pathToFileURL(filePath).toString();

    // Try pull-based (LSP 3.17+ textDocument/diagnostic)
    try {
      const res = await this.request<{ items?: LSPDiagnostic[] }>(
        'textDocument/diagnostic',
        { textDocument: { uri } },
        6_000,
      );
      if (Array.isArray(res?.items)) return res.items;
    } catch { /* server may not support pull diagnostics */ }

    // Fall back to push-based: wait for publishDiagnostics notification (5 s)
    const cached = this.diagnosticsMap.get(uri);
    if (cached !== undefined) return cached;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.off('diagnostics', handler);
        resolve([]);
      }, 5_000);
      const handler = (params: { uri: string; diagnostics: LSPDiagnostic[] }) => {
        if (params.uri === uri) {
          clearTimeout(timeout);
          this.off('diagnostics', handler);
          resolve(params.diagnostics);
        }
      };
      this.on('diagnostics', handler);
    });
  }

  async hover(filePath: string, line: number, character: number): Promise<LSPHoverResult | null> {
    const uri = pathToFileURL(filePath).toString();
    return this.request<LSPHoverResult | null>('textDocument/hover', {
      textDocument: { uri },
      position: { line, character },
    });
  }

  async definition(filePath: string, line: number, character: number): Promise<LSPLocation[]> {
    const uri = pathToFileURL(filePath).toString();
    const result = await this.request<LSPLocation | LSPLocation[] | null>('textDocument/definition', {
      textDocument: { uri },
      position: { line, character },
    });
    if (!result) return [];
    return Array.isArray(result) ? result : [result];
  }

  async references(filePath: string, line: number, character: number): Promise<LSPLocation[]> {
    const uri = pathToFileURL(filePath).toString();
    const result = await this.request<LSPLocation[] | null>('textDocument/references', {
      textDocument: { uri },
      position: { line, character },
      context: { includeDeclaration: true },
    });
    return result ?? [];
  }

  async shutdown(): Promise<void> {
    if (!this._isRunning) return;
    this._isRunning = false;
    try {
      await this.request('shutdown', null, 3_000);
      this.notify('exit');
    } catch { /* ignore */ }
    this.proc?.kill();
    this.proc = null;
  }
}
