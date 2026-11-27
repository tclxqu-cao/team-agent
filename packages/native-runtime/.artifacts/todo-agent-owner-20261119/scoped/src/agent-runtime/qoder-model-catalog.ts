import { execFile } from "node:child_process";
import { promisify, stripVTControlCharacters } from "node:util";
import { resolveNativeCliCommand } from "./native-cli-command.js";
import type { NativeStdioCommand } from "./native-stdio-channel.js";
import { RuntimeSessionError, type RuntimeModelInfo } from "./types.js";

const execFileAsync = promisify(execFile);

export type QoderModelCatalogLoader = () => Promise<RuntimeModelInfo[]>;

type CatalogExecutor = (
  command: string,
  args: string[],
  options: {
    encoding: "utf8";
    timeout: number;
    maxBuffer: number;
    env: NodeJS.ProcessEnv;
    cwd?: string;
    shell: false;
    windowsHide: true;
  },
) => Promise<{ stdout: string }>;

/** Qoder CLI 1.1.85 emits a single MODEL column, even with JSON output requested. */
export function parseQoderModelCatalog(stdout: string): RuntimeModelInfo[] {
  const lines = stripVTControlCharacters(stdout).replace(/\r\n?/g, "\n").split("\n").map(line => line.trim()).filter(Boolean);
  if (lines.shift() !== "MODEL") return [];

  const models = new Map<string, RuntimeModelInfo>();
  for (const line of lines) {
    if (/^(?:error|warning|fatal|failed|unauthorized|unauthenticated|forbidden|authentication|login|log[ -]?in|sign[ -]?in|please|usage|notice|hint)(?:[\s:_-]|$)/i.test(line)
      || /\b(?:not logged in|not authenticated|sign in|log in)\b/i.test(line)) return [];
    if (line === "MODEL") continue;
    let id = line;
    let displayName = line;
    const separator = line.lastIndexOf(" (");
    if (separator > 0 && line.endsWith(")")) {
      displayName = line.slice(0, separator).trim();
      id = line.slice(separator + 2, -1);
      if (!id || /[\s()\x00-\x1f\x7f]/.test(id)) continue;
    } else if (!/^[\p{L}\p{N}_][\p{L}\p{N}_./+-]*$/u.test(line)) {
      // Bare native presets have no separate ID. Do not accept prose or broken rows.
      continue;
    }
    // The CLI truncates long IDs to the terminal width; never guess a selectable ID.
    if (id.includes("…") || id.includes("...")) continue;
    if (!models.has(id)) models.set(id, { id, displayName });
  }
  return [...models.values()];
}

/** Enumerate models without starting ACP or creating/resuming any native session. */
export async function loadQoderModelCatalog(options: {
  resolveCommand?: () => Promise<NativeStdioCommand>;
  execute?: CatalogExecutor;
} = {}): Promise<RuntimeModelInfo[]> {
  try {
    const resolved = await (options.resolveCommand ?? (() => resolveNativeCliCommand("qoder")))();
    const execute = options.execute ?? execFileAsync as CatalogExecutor;
    const { stdout } = await execute(resolved.command, [...(resolved.args ?? []).filter(arg => arg !== "--acp"), "--list-models"], {
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, ...resolved.env },
      cwd: resolved.cwd,
      shell: false,
      windowsHide: true,
    });
    return parseQoderModelCatalog(stdout);
  } catch {
    // Process errors may include stdout, stderr or environment credentials.
    throw new RuntimeSessionError("Unable to list Qoder models; check the native CLI installation and sign-in", "RUNTIME_UNAVAILABLE");
  }
}
