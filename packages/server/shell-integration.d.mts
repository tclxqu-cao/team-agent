export interface TerminalShellLaunchOptions {
  shell: string;
  command?: string;
  serverBaseDir: string;
  homeDir: string;
  env?: Record<string, string | undefined>;
}

export interface TerminalShellLaunch {
  args: string[];
  env: Record<string, string | undefined>;
  waitsForReady: boolean;
}

export const TERMINAL_READY_MARKER: string;
export const ZSH_HISTORY_HOOK: string;

export function ensureManagedZshDir(options: Omit<TerminalShellLaunchOptions, "shell" | "command">): string;
export function createTerminalShellLaunch(options: TerminalShellLaunchOptions): TerminalShellLaunch;
export function consumeTerminalReadyMarker(tail: string, data: string): { ready: boolean; tail: string };
