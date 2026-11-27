import { EventEmitter } from 'node:events';
import type { LSPServerConfig, LSPDiagnostic, LSPHoverResult, LSPLocation } from './entities.js';
export declare class LSPClient extends EventEmitter {
    private readonly config;
    private proc;
    private nextId;
    private pending;
    private buffer;
    private diagnosticsMap;
    private _isRunning;
    constructor(config: LSPServerConfig);
    get isRunning(): boolean;
    start(workspaceRoot: string): Promise<void>;
    private flushBuffer;
    private dispatch;
    private write;
    private request;
    private notify;
    private initialize;
    /** Open a file so the LSP server knows about it. Reads from disk. */
    openDocument(filePath: string): void;
    closeDocument(filePath: string): void;
    /** Get diagnostics (errors/warnings) for a file. */
    getDiagnostics(filePath: string): Promise<LSPDiagnostic[]>;
    hover(filePath: string, line: number, character: number): Promise<LSPHoverResult | null>;
    definition(filePath: string, line: number, character: number): Promise<LSPLocation[]>;
    references(filePath: string, line: number, character: number): Promise<LSPLocation[]>;
    shutdown(): Promise<void>;
}
//# sourceMappingURL=LSPClient.d.ts.map