import { z } from "zod";
import type { ITool, ToolContext, ToolResult } from '../../../domain/tool/entities.js';
import type { LSPManager } from '../../lsp/LSPManager.js';
import type { LSPServerConfig } from '../../../domain/lsp/entities.js';
export declare class LspDiagnosticsTool implements ITool {
    private readonly lspManager;
    private readonly getConfigs;
    readonly name = "lsp_diagnostics";
    readonly description: string;
    readonly schema: z.ZodObject<{
        file_path: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        file_path: string;
    }, {
        file_path: string;
    }>;
    readonly parameters: Record<string, unknown>;
    constructor(lspManager: LSPManager, getConfigs: () => Promise<LSPServerConfig[]>);
    execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
    private schemaToParams;
}
export declare class LspHoverTool implements ITool {
    private readonly lspManager;
    private readonly getConfigs;
    readonly name = "lsp_hover";
    readonly description = "Get hover information (type signature, documentation) for a symbol at a given position in a source file.";
    readonly schema: z.ZodObject<{
        file_path: z.ZodString;
        line: z.ZodNumber;
        character: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        file_path: string;
        line: number;
        character: number;
    }, {
        file_path: string;
        line: number;
        character: number;
    }>;
    readonly parameters: Record<string, unknown>;
    constructor(lspManager: LSPManager, getConfigs: () => Promise<LSPServerConfig[]>);
    execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
    private schemaToParams;
}
export declare class LspDefinitionTool implements ITool {
    private readonly lspManager;
    private readonly getConfigs;
    readonly name = "lsp_definition";
    readonly description = "Go-to-definition: find where a symbol is defined, given its position in a source file.";
    readonly schema: z.ZodObject<{
        file_path: z.ZodString;
        line: z.ZodNumber;
        character: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        file_path: string;
        line: number;
        character: number;
    }, {
        file_path: string;
        line: number;
        character: number;
    }>;
    readonly parameters: Record<string, unknown>;
    constructor(lspManager: LSPManager, getConfigs: () => Promise<LSPServerConfig[]>);
    execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
    private schemaToParams;
}
export declare class LspReferencesTool implements ITool {
    private readonly lspManager;
    private readonly getConfigs;
    readonly name = "lsp_references";
    readonly description = "Find all references (usages) of a symbol across the codebase, given its position in a source file.";
    readonly schema: z.ZodObject<{
        file_path: z.ZodString;
        line: z.ZodNumber;
        character: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        file_path: string;
        line: number;
        character: number;
    }, {
        file_path: string;
        line: number;
        character: number;
    }>;
    readonly parameters: Record<string, unknown>;
    constructor(lspManager: LSPManager, getConfigs: () => Promise<LSPServerConfig[]>);
    execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
    private schemaToParams;
}
//# sourceMappingURL=LspTools.d.ts.map