// ── LSP Tools ──
// Four tools: lsp_diagnostics, lsp_hover, lsp_definition, lsp_references
import { z } from "zod";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ITool, ToolContext, ToolResult } from '../entities.js';
import type { LSPManager } from '../../lsp/LSPManager.js';
import type { LSPServerConfig } from '../../lsp/entities.js';

/** Shared helper — format a URI returned by LSP into a readable path. */
function uriToPath(uri: string): string {
  try { return fileURLToPath(uri); } catch { return uri; }
}

/** Severity number → label */
function severity(n?: number): string {
  return ['', 'Error', 'Warning', 'Information', 'Hint'][n ?? 0] ?? 'Unknown';
}

// ── lsp_diagnostics ──────────────────────────────────────────────────────────

export class LspDiagnosticsTool implements ITool {
  readonly name = 'lsp_diagnostics';
  readonly description =
    'Get language-server diagnostics (errors, warnings, hints) for a source file. ' +
    'Requires an LSP server configured for the file\'s language.';
  readonly schema = z.object({
    file_path: z.string().describe('Absolute or workspace-relative path to the source file'),
  });
  readonly parameters = this.schemaToParams();

  constructor(
    private readonly lspManager: LSPManager,
    private readonly getConfigs: () => Promise<LSPServerConfig[]>,
  ) {}

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const parsed = this.schema.safeParse(params);
    if (!parsed.success) return { toolCallId: '', content: `Invalid params: ${parsed.error.message}`, isError: true };

    const filePath = resolve(ctx.workingDirectory, parsed.data.file_path);
    const configs = await this.getConfigs();
    const config = this.lspManager.configForFile(filePath, configs);
    if (!config) return { toolCallId: '', content: `No LSP server configured for this file type.`, isError: true };

    try {
      const client = await this.lspManager.getClient(config, ctx.workingDirectory);
      client.openDocument(filePath);
      // Give push-based servers a moment to emit diagnostics
      await new Promise((r) => setTimeout(r, 800));
      const diags = await client.getDiagnostics(filePath);
      client.closeDocument(filePath);

      if (diags.length === 0) return { toolCallId: '', content: 'No diagnostics — file looks clean.' };
      const lines = diags.map((d) => {
        const loc = `${filePath}:${d.range.start.line + 1}:${d.range.start.character + 1}`;
        return `[${severity(d.severity)}] ${loc}\n  ${d.message}${d.code ? ` (${d.code})` : ''}`;
      });
      return { toolCallId: '', content: lines.join('\n\n') };
    } catch (err) {
      return { toolCallId: '', content: `LSP error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  }

  private schemaToParams(): Record<string, unknown> {
    return {
      type: 'object',
      properties: { file_path: { type: 'string', description: 'Absolute or workspace-relative path to the source file' } },
      required: ['file_path'],
    };
  }
}

// ── lsp_hover ────────────────────────────────────────────────────────────────

export class LspHoverTool implements ITool {
  readonly name = 'lsp_hover';
  readonly description =
    'Get hover information (type signature, documentation) for a symbol at a given position in a source file.';
  readonly schema = z.object({
    file_path: z.string().describe('Absolute or workspace-relative path to the source file'),
    line: z.number().int().min(1).describe('1-based line number'),
    character: z.number().int().min(1).describe('1-based character offset'),
  });
  readonly parameters = this.schemaToParams();

  constructor(
    private readonly lspManager: LSPManager,
    private readonly getConfigs: () => Promise<LSPServerConfig[]>,
  ) {}

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const parsed = this.schema.safeParse(params);
    if (!parsed.success) return { toolCallId: '', content: `Invalid params: ${parsed.error.message}`, isError: true };

    const filePath = resolve(ctx.workingDirectory, parsed.data.file_path);
    const configs = await this.getConfigs();
    const config = this.lspManager.configForFile(filePath, configs);
    if (!config) return { toolCallId: '', content: `No LSP server configured for this file type.`, isError: true };

    try {
      const client = await this.lspManager.getClient(config, ctx.workingDirectory);
      client.openDocument(filePath);
      const result = await client.hover(filePath, parsed.data.line - 1, parsed.data.character - 1);
      client.closeDocument(filePath);

      if (!result) return { toolCallId: '', content: 'No hover information at this position.' };
      const { contents } = result;
      const text = typeof contents === 'string'
        ? contents
        : Array.isArray(contents)
          ? contents.map((c) => (typeof c === 'string' ? c : c.value)).join('\n')
          : (contents as { value?: string }).value ?? JSON.stringify(contents);
      return { toolCallId: '', content: text };
    } catch (err) {
      return { toolCallId: '', content: `LSP error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  }

  private schemaToParams(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to source file' },
        line: { type: 'number', description: '1-based line number' },
        character: { type: 'number', description: '1-based character offset' },
      },
      required: ['file_path', 'line', 'character'],
    };
  }
}

// ── lsp_definition ───────────────────────────────────────────────────────────

export class LspDefinitionTool implements ITool {
  readonly name = 'lsp_definition';
  readonly description =
    'Go-to-definition: find where a symbol is defined, given its position in a source file.';
  readonly schema = z.object({
    file_path: z.string(),
    line: z.number().int().min(1).describe('1-based line number'),
    character: z.number().int().min(1).describe('1-based character offset'),
  });
  readonly parameters = this.schemaToParams();

  constructor(
    private readonly lspManager: LSPManager,
    private readonly getConfigs: () => Promise<LSPServerConfig[]>,
  ) {}

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const parsed = this.schema.safeParse(params);
    if (!parsed.success) return { toolCallId: '', content: `Invalid params: ${parsed.error.message}`, isError: true };

    const filePath = resolve(ctx.workingDirectory, parsed.data.file_path);
    const configs = await this.getConfigs();
    const config = this.lspManager.configForFile(filePath, configs);
    if (!config) return { toolCallId: '', content: 'No LSP server configured for this file type.', isError: true };

    try {
      const client = await this.lspManager.getClient(config, ctx.workingDirectory);
      client.openDocument(filePath);
      const locations = await client.definition(filePath, parsed.data.line - 1, parsed.data.character - 1);
      client.closeDocument(filePath);

      if (locations.length === 0) return { toolCallId: '', content: 'No definition found.' };
      const lines = locations.map((l) => {
        const p = uriToPath(l.uri);
        return `${p}:${l.range.start.line + 1}:${l.range.start.character + 1}`;
      });
      return { toolCallId: '', content: lines.join('\n') };
    } catch (err) {
      return { toolCallId: '', content: `LSP error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  }

  private schemaToParams(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        line: { type: 'number', description: '1-based line number' },
        character: { type: 'number', description: '1-based character offset' },
      },
      required: ['file_path', 'line', 'character'],
    };
  }
}

// ── lsp_references ───────────────────────────────────────────────────────────

export class LspReferencesTool implements ITool {
  readonly name = 'lsp_references';
  readonly description =
    'Find all references (usages) of a symbol across the codebase, given its position in a source file.';
  readonly schema = z.object({
    file_path: z.string(),
    line: z.number().int().min(1).describe('1-based line number'),
    character: z.number().int().min(1).describe('1-based character offset'),
  });
  readonly parameters = this.schemaToParams();

  constructor(
    private readonly lspManager: LSPManager,
    private readonly getConfigs: () => Promise<LSPServerConfig[]>,
  ) {}

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const parsed = this.schema.safeParse(params);
    if (!parsed.success) return { toolCallId: '', content: `Invalid params: ${parsed.error.message}`, isError: true };

    const filePath = resolve(ctx.workingDirectory, parsed.data.file_path);
    const configs = await this.getConfigs();
    const config = this.lspManager.configForFile(filePath, configs);
    if (!config) return { toolCallId: '', content: 'No LSP server configured for this file type.', isError: true };

    try {
      const client = await this.lspManager.getClient(config, ctx.workingDirectory);
      client.openDocument(filePath);
      const locations = await client.references(filePath, parsed.data.line - 1, parsed.data.character - 1);
      client.closeDocument(filePath);

      if (locations.length === 0) return { toolCallId: '', content: 'No references found.' };
      const lines = locations.map((l) => {
        const p = uriToPath(l.uri);
        return `${p}:${l.range.start.line + 1}:${l.range.start.character + 1}`;
      });
      return { toolCallId: '', content: `Found ${lines.length} reference(s):\n${lines.join('\n')}` };
    } catch (err) {
      return { toolCallId: '', content: `LSP error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  }

  private schemaToParams(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        line: { type: 'number', description: '1-based line number' },
        character: { type: 'number', description: '1-based character offset' },
      },
      required: ['file_path', 'line', 'character'],
    };
  }
}
