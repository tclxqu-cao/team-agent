// ── Plugin Domain ──

import type { ITool } from '../tool/entities.js';
import type { SkillDefinition } from '../skill/entities.js';

/** Permissions a plugin can request */
export interface PluginPermissions {
  fileSystem?: boolean;
  network?: boolean;
  subprocess?: boolean;
  tools?: string[]; // tool names the plugin can access
}

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  permissions: PluginPermissions;
  main: string; // entry file path
}

export interface PluginAPI {
  registerTool(tool: ITool): void;
  registerSkill(skill: SkillDefinition): void;
  getWorkingDirectory(): string;
  log(message: string, level?: "info" | "warn" | "error"): void;
}

export interface IPlugin {
  readonly manifest: PluginManifest;
  readonly loaded: boolean;

  load(): Promise<void>;
  activate(api: PluginAPI): Promise<void>;
  deactivate(): Promise<void>;
}

export interface IPluginLoader {
  /** Load a plugin from its directory (reads manifest.json) */
  loadFromDirectory(dirPath: string): Promise<IPlugin>;
  /** Create a plugin instance from a manifest */
  create(manifest: PluginManifest): IPlugin;
}

export interface IPluginManager {
  loadPlugin(dirPath: string): Promise<IPlugin>;
  unloadPlugin(name: string): Promise<void>;
  activatePlugin(name: string, api: PluginAPI): Promise<void>;
  deactivatePlugin(name: string): Promise<void>;
  getPlugin(name: string): IPlugin | undefined;
  listPlugins(): IPlugin[];
}
