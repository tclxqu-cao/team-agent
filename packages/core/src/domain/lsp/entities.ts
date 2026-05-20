// ── LSP Domain ──

export interface LSPServerConfig {
  id: string;
  name: string;
  /** e.g. "typescript", "python", "rust" */
  language: string;
  /** File extensions this server handles, e.g. [".ts", ".tsx", ".js"] */
  fileTypes: string[];
  /** Executable command, e.g. "typescript-language-server" */
  command: string;
  /** CLI arguments, e.g. ["--stdio"] */
  args: string[];
  /** Extra environment variables */
  env?: Record<string, string>;
  enabled: boolean;
}

export interface LSPPosition {
  line: number;       // 0-based
  character: number;  // 0-based
}

export interface LSPRange {
  start: LSPPosition;
  end: LSPPosition;
}

export interface LSPDiagnostic {
  range: LSPRange;
  severity?: 1 | 2 | 3 | 4; // Error=1, Warning=2, Information=3, Hint=4
  code?: string | number;
  source?: string;
  message: string;
  relatedInformation?: Array<{ location: { uri: string; range: LSPRange }; message: string }>;
}

export interface LSPLocation {
  uri: string;
  range: LSPRange;
}

export interface LSPHoverResult {
  contents: string | { kind: string; value: string } | Array<{ language?: string; value: string }>;
  range?: LSPRange;
}

export interface ILSPServerStore {
  list(): Promise<LSPServerConfig[]>;
  listAll(): Promise<LSPServerConfig[]>;
  get(id: string): Promise<LSPServerConfig | null>;
  save(config: LSPServerConfig): Promise<void>;
  delete(id: string): Promise<void>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
}
