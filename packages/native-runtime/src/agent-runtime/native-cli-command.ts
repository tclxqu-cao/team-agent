import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import type { NativeAgentType } from "@agent/core";
import type { NativeStdioCommand } from "./native-stdio-channel.js";
import { RuntimeSessionError } from "./types.js";
import { discoverWorkBuddyDesktopProductConfig } from "./workbuddy-desktop-config.js";

export type BridgedNativeAgentType = Extract<NativeAgentType, "qoder" | "zcode" | "workbuddy" | "grok" | "agy">;

interface Options {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  nodeExecutable?: string;
  fileExists?(path: string): Promise<boolean>;
  workBuddyDesktopConfig?(options: { configDir: string; platform: NodeJS.Platform }): Promise<string | null>;
}

const CLI = {
  qoder: { override: "AGENT_QODER_BIN", names: ["qodercli"], args: ["--acp"], localBin: true },
  zcode: { override: "AGENT_ZCODE_BIN", names: ["zcode"], args: ["app-server"] },
  workbuddy: { override: "AGENT_WORKBUDDY_BIN", names: ["workbuddy", "codebuddy"],
    args: ["--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages"] },
  grok: { override: "AGENT_GROK_BIN", names: ["grok"], args: ["--no-auto-update", "agent", "stdio"], localBin: true },
  agy: { override: "AGENT_AGY_BIN", names: ["agy"], args: ["acp"], localBin: true },
} satisfies Record<BridgedNativeAgentType, { override: string; names: string[]; args: string[]; localBin?: boolean }>;

async function fileExists(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); }
  catch { return false; }
}

/** Resolves only entrypoints and child environment; native apps retain their credentials. */
export async function resolveNativeCliCommand(agent: BridgedNativeAgentType, options: Options = {}): Promise<NativeStdioCommand> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const paths = platform === "win32" ? win32 : posix;
  const exists = options.fileExists ?? fileExists;
  const inPath = async (name: string) => {
    const directories = (env.PATH ?? env.Path ?? "").split(paths.delimiter).filter(Boolean);
    for (const directory of directories) {
      for (const suffix of platform === "win32" ? [".exe", ""] : [""]) {
        const candidate = paths.join(directory, name + suffix);
        if (await exists(candidate)) return candidate;
      }
    }
    return null;
  };
  const config = CLI[agent];
  const override = env[config.override]?.trim();
  let executable: string | null = null;
  if (override) {
    executable = /[\\/]/.test(override) ? (await exists(override) ? override : null) : await inPath(override);
    if (!executable) throw new RuntimeSessionError(`${config.override} does not identify an installed runtime`, "RUNTIME_UNAVAILABLE");
  }
  const bundles: string[] = [];
  if (platform === "darwin") {
    for (const applications of ["/Applications", paths.join(home, "Applications")]) {
      if (agent === "zcode") bundles.push(paths.join(applications, "ZCode.app/Contents/Resources/glm/zcode.cjs"));
      if (agent === "workbuddy") bundles.push(paths.join(applications, "WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy"));
    }
  } else if (platform === "win32") {
    for (const base of [env.LOCALAPPDATA && paths.join(env.LOCALAPPDATA, "Programs"), env.ProgramFiles, env.PROGRAMFILES].filter((value): value is string => Boolean(value))) {
      if (agent === "zcode") bundles.push(paths.join(base, "ZCode/resources/glm/zcode.cjs"));
      if (agent === "workbuddy") bundles.push(paths.join(base, "WorkBuddy/resources/app.asar.unpacked/cli/bin/codebuddy"));
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
  if (!executable && "localBin" in config && config.localBin) {
    const candidate = paths.join(home, ".local/bin", config.names[0] + (platform === "win32" ? ".exe" : ""));
    if (await exists(candidate)) executable = candidate;
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
  const nodeEntrypoint = /\.[cm]?js$/i.test(executable) || /[\\/]cli[\\/]bin[\\/]codebuddy$/.test(executable);
  let nodeExecutable = options.nodeExecutable ?? env.AGENT_NATIVE_NODE_BIN;
  if (nodeEntrypoint && !nodeExecutable) {
    nodeExecutable = !process.versions.electron && !process.versions.bun ? process.execPath : await inPath("node") ?? undefined;
    if (!nodeExecutable && platform === "darwin") {
      for (const candidate of ["/opt/homebrew/bin/node", "/usr/local/bin/node"]) {
        if (await exists(candidate)) { nodeExecutable = candidate; break; }
      }
    }
    if (!nodeExecutable) throw new RuntimeSessionError("A Node.js runtime is required; set AGENT_NATIVE_NODE_BIN", "RUNTIME_UNAVAILABLE");
  }
  return { command: nodeEntrypoint ? nodeExecutable! : executable, args: nodeEntrypoint ? [executable, ...args] : args, env: childEnv };
}
