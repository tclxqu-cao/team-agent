import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import type { NativeAgentType } from "@agent/core";
import type { NativeStdioCommand } from "./native-stdio-channel.js";
import { RuntimeSessionError } from "./types.js";
import { discoverWorkBuddyDesktopProductConfig } from "./workbuddy-desktop-config.js";

export type BridgedNativeAgentType = Extract<NativeAgentType, "qoder" | "zcode" | "workbuddy" | "grok" | "agy">;
type NativeCliAgent = BridgedNativeAgentType | "claude-code" | "deepseek-harness";

interface Options {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  nodeExecutable?: string;
  fileExists?(path: string): Promise<boolean>;
  readTextFile?(path: string): Promise<string>;
  workBuddyDesktopConfig?(options: { configDir: string; platform: NodeJS.Platform }): Promise<string | null>;
}

const CLI: Record<NativeCliAgent, { override: string; names: string[]; args: string[]; localBin?: boolean }> = {
  qoder: { override: "AGENT_QODER_BIN", names: ["qodercli"], args: ["--acp"], localBin: true },
  zcode: { override: "AGENT_ZCODE_BIN", names: ["zcode"], args: ["app-server"] },
  workbuddy: { override: "AGENT_WORKBUDDY_BIN", names: ["workbuddy", "codebuddy"],
    args: ["--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages"] },
  grok: { override: "AGENT_GROK_BIN", names: ["grok"], args: ["--no-auto-update", "agent", "stdio"], localBin: true },
  agy: { override: "AGENT_AGY_BIN", names: ["agy"], args: ["acp"], localBin: true },
  "claude-code": { override: "AGENT_CLAUDE_BIN", names: ["claude"], args: [], localBin: true },
  "deepseek-harness": { override: "AGENT_DSH_EXECUTABLE", names: ["dsh"], args: [] },
};

const WINDOWS_NPM_ENTRIES: Partial<Record<NativeCliAgent, readonly string[]>> = {
  qoder: ["@qoder-ai/qodercli/bundle/qodercli.js", "@qoder-ai/qodercli/cli.js"],
  workbuddy: ["@tencent-ai/codebuddy-code/bin/codebuddy"],
  "claude-code": ["@anthropic-ai/claude-code/bin/claude.exe", "@anthropic-ai/claude-code/cli.js"],
  "deepseek-harness": ["@deepseek-ai/dsh/lib/bin.js"],
};

async function fileExists(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); }
  catch { return false; }
}

async function findWindowsQoder(home: string, local: string, exists: typeof fileExists, readTextFile: (path: string) => Promise<string>): Promise<string | null> {
  const qoderBin = win32.join(home, ".qoder", "bin");
  const nativeDirectories = [win32.join(local, "qodercli"), qoderBin, win32.join(local, "Qoder")];
  for (const directory of nativeDirectories) {
    const executable = win32.join(directory, "qodercli.exe");
    if (await exists(executable)) return executable;
  }

  const installDir = win32.join(qoderBin, "qodercli");
  const version = (await readTextFile(win32.join(installDir, "version.txt")).catch(() => "")).trim();
  if (/^\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/.test(version)) {
    const executable = win32.join(installDir, `qodercli-${version}.exe`);
    if (await exists(executable)) return executable;
  }

  return null;
}

async function findWindowsNpmEntry(agent: NativeCliAgent, prefixes: Iterable<string>, exists: typeof fileExists): Promise<string | null> {
  // Resolve official package entries instead of executing shell shims.
  for (const prefix of new Set(prefixes)) {
    if (!prefix) continue;
    const modules = win32.basename(prefix).toLowerCase() === ".bin"
      ? win32.dirname(prefix)
      : win32.join(prefix, "node_modules");
    for (const entry of WINDOWS_NPM_ENTRIES[agent] ?? []) {
      const candidate = win32.join(modules, entry);
      if (await exists(candidate)) return candidate;
    }
  }
  return null;
}

function isHarnessLauncherDirectory(path: string): boolean {
  return /[\\/]resources[\\/]runtime[\\/]cli[\\/]bin$/i.test(path);
}

async function findWindowsHarnessDesktop(roots: readonly string[], exists: typeof fileExists): Promise<NativeStdioCommand | null> {
  // Mirror the vendor's dsh.cmd entrypoint with the Desktop executable and
  // explicit arguments. Node outside Electron cannot read the asar itself.
  for (const root of roots) {
    const command = win32.join(root, "DeepSeek Harness.exe");
    const resources = win32.join(root, "resources");
    const archive = win32.join(resources, "app.asar");
    if (!await exists(win32.join(resources, "runtime", "cli", "bin", "dsh.cmd"))
      || !await exists(command) || !await exists(archive)) continue;
    const entry = win32.join(archive, "dsh", "node_modules", "@deepseek-ai", "dsh-desktop-host", "lib", "cli.js");
    return { command, args: ["--expose-internals", entry], env: { ELECTRON_RUN_AS_NODE: "1" } };
  }
  return null;
}

/** Resolves only entrypoints and child environment; native apps retain their credentials. */
export async function resolveNativeCliCommand(agent: NativeCliAgent, options: Options = {}): Promise<NativeStdioCommand> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const paths = platform === "win32" ? win32 : posix;
  const exists = options.fileExists ?? fileExists;
  const windows = platform === "win32";
  const local = env.LOCALAPPDATA || win32.join(home, "AppData", "Local");
  const pathDirectories = (env.PATH ?? env.Path ?? "").split(paths.delimiter)
    .map(dir => windows ? dir.trim().replace(/^"(.*)"$/, "$1") : dir).filter(Boolean);
  const defaultNpm = win32.join(env.APPDATA || win32.join(home, "AppData", "Roaming"), "npm");
  const inPath = async (name: string) => {
    const suffix = windows && !paths.extname(name) ? ".exe" : "";
    for (const directory of pathDirectories) {
      const candidate = paths.join(directory, name + suffix);
      if (await exists(candidate)) return candidate;
    }
    return null;
  };
  const config = CLI[agent];
  const override = env[config.override]?.trim();
  let executable: string | null = null;
  if (override) {
    if (windows && /\.(?:cmd|bat)$/i.test(override)) {
      const shim = /[\\/]/.test(override) ? override : await inPath(override);
      if (shim && await exists(shim)) {
        const directory = win32.dirname(shim);
        executable = await findWindowsNpmEntry(agent, [directory], exists);
        if (!executable && agent === "deepseek-harness" && isHarnessLauncherDirectory(directory)) {
          const desktop = await findWindowsHarnessDesktop([win32.resolve(directory, "../../../..")], exists);
          if (desktop) return desktop;
        }
      }
    } else {
      executable = /[\\/]/.test(override) ? (await exists(override) ? override : null) : await inPath(override);
    }
    if (!executable) throw new RuntimeSessionError(`${config.override} does not identify an installed runtime`, "RUNTIME_UNAVAILABLE");
  }
  const bundles: string[] = [];
  if (platform === "darwin") {
    for (const applications of ["/Applications", paths.join(home, "Applications")]) {
      if (agent === "zcode") bundles.push(paths.join(applications, "ZCode.app/Contents/Resources/glm/zcode.cjs"));
      if (agent === "workbuddy") bundles.push(paths.join(applications, "WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy"));
    }
  } else if (windows) {
    for (const base of [paths.join(local, "Programs"), env.ProgramFiles ?? env.PROGRAMFILES].filter((value): value is string => Boolean(value))) {
      if (agent === "zcode") bundles.push(paths.join(base, "ZCode/resources/glm/zcode.cjs"));
      if (agent === "workbuddy") {
        bundles.push(paths.join(base, "WorkBuddy/resources/app.asar.unpacked/cli/bin/codebuddy.exe"));
        bundles.push(paths.join(base, "WorkBuddy/resources/app.asar.unpacked/cli/bin/codebuddy"));
      }
    }
  }
  for (const candidate of bundles) {
    if (!executable && await exists(candidate)) executable = candidate;
  }
  if (!executable) {
    for (const name of config.names) {
      executable = await inPath(name);
      if (executable) break;
    }
  }
  if (!executable && config.localBin) {
    const candidate = paths.join(home, ".local/bin", config.names[0] + (platform === "win32" ? ".exe" : ""));
    if (await exists(candidate)) executable = candidate;
  }
  if (!executable && windows) {
    if (agent === "qoder") executable = await findWindowsQoder(home, local, exists, options.readTextFile ?? (path => readFile(path, "utf8")));
    const standalonePaths: Partial<Record<NativeCliAgent, string>> = {
      workbuddy: win32.join(local, "codebuddy", "bin", "codebuddy.exe"),
      agy: win32.join(local, "agy", "bin", "agy.exe"),
      grok: win32.join(env.GROK_BIN_DIR || win32.join(home, ".grok", "bin"), "grok.exe"),
    };
    const standalone = standalonePaths[agent];
    if (!executable && standalone && await exists(standalone)) executable = standalone;
    if (!executable) executable = await findWindowsNpmEntry(agent, [...pathDirectories, env.npm_config_prefix || env.NPM_CONFIG_PREFIX || "", defaultNpm], exists);
    if (!executable && agent === "deepseek-harness") {
      const launcherDirs = pathDirectories.filter(isHarnessLauncherDirectory);
      const programs = [win32.join(local, "Programs"), env.ProgramFiles ?? env.PROGRAMFILES];
      const desktop = await findWindowsHarnessDesktop([
        ...launcherDirs.map(dir => win32.resolve(dir, "../../../..")),
        ...programs.filter((dir): dir is string => Boolean(dir)).map(dir => win32.join(dir, "DeepSeek Harness")),
      ], exists);
      if (desktop) return desktop;
    }
  }
  if (!executable) throw new RuntimeSessionError(`${agent} runtime is not installed; set ${config.override} to its entrypoint`, "RUNTIME_UNAVAILABLE");

  const childEnv: NodeJS.ProcessEnv = {};
  if (agent === "zcode") {
    const builtin = paths.join(paths.dirname(paths.dirname(executable)), "config/provider/zcode-builtin.json");
    const personal = paths.join(home, ".zcode/v2/provider_config.json");
    if (env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE) childEnv.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
    else if (await exists(builtin)) childEnv.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = builtin;
    if (env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE) childEnv.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
    else if (await exists(personal)) childEnv.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = personal;
  }
  if (agent === "workbuddy") {
    childEnv.CODEBUDDY_FORCE_LITE_WB_BUNDLE = "1";
    const configDir = env.WORKBUDDY_CONFIG_DIR || env.CODEBUDDY_CONFIG_DIR || paths.join(home, ".workbuddy");
    childEnv.CODEBUDDY_CONFIG_DIR = configDir;
    childEnv.WORKBUDDY_CONFIG_DIR = configDir;
    const desktopConfig = await (options.workBuddyDesktopConfig ?? discoverWorkBuddyDesktopProductConfig)({ configDir, platform });
    if (desktopConfig) {
      childEnv.ACC_PRODUCT_CONFIG_PATH = desktopConfig;
      // Inline overlays take precedence over the desktop path inside the native CLI.
      childEnv.ACC_PRODUCT_CONFIG_V3 = "";
      childEnv.ACC_PRODUCT_CONFIG_V2 = "";
      childEnv.ACC_PRODUCT_CONFIG = "";
    } else if (platform === "darwin" && /[\\/]WorkBuddy(?: AI)?\.app[\\/]/.test(executable)) {
      throw new RuntimeSessionError("Open WorkBuddy desktop and wait for its model configuration to load", "RUNTIME_UNAVAILABLE");
    }
  }
  const args = [...config.args];
  const nodeEntrypoint = /\.[cm]?js$/i.test(executable) || /[\\/](?:cli|codebuddy-code)[\\/]bin[\\/]codebuddy$/.test(executable);
  let nodeExecutable = options.nodeExecutable ?? env.AGENT_NATIVE_NODE_BIN;
  if (nodeEntrypoint && !nodeExecutable) {
    nodeExecutable = !process.versions.electron && !process.versions.bun
      ? process.execPath
      : env.AGENTROAM_MANAGED_NODE || await inPath("node") || undefined;
    if (!nodeExecutable && platform === "darwin") {
      for (const candidate of ["/opt/homebrew/bin/node", "/usr/local/bin/node"]) {
        if (await exists(candidate)) { nodeExecutable = candidate; break; }
      }
    }
    if (!nodeExecutable) throw new RuntimeSessionError("A Node.js runtime is required; set AGENT_NATIVE_NODE_BIN", "RUNTIME_UNAVAILABLE");
  }
  return { command: nodeEntrypoint ? nodeExecutable! : executable, args: nodeEntrypoint ? [executable, ...args] : args, env: childEnv };
}
