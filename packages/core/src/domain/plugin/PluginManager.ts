import type {
  IPluginManager,
  IPlugin,
  IPluginLoader,
  PluginManifest,
  PluginAPI,
} from './entities.js';
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { IToolRegistry, ITool } from '../tool/entities.js';
import type { ISkillRegistry, SkillDefinition } from '../skill/entities.js';

export class PluginManager implements IPluginManager, IPluginLoader {
  private readonly plugins = new Map<string, IPlugin>();

  constructor(
    private readonly toolRegistry?: IToolRegistry,
    private readonly skillRegistry?: ISkillRegistry,
    private readonly workingDirectory?: string,
  ) {}

  async loadPlugin(dirPath: string): Promise<IPlugin> {
    const plugin = await this.loadFromDirectory(dirPath);
    this.plugins.set(plugin.manifest.name, plugin);
    return plugin;
  }

  async unloadPlugin(name: string): Promise<void> {
    const plugin = this.plugins.get(name);
    if (plugin) {
      await this.deactivatePlugin(name);
      this.plugins.delete(name);
    }
  }

  async activatePlugin(name: string, api?: PluginAPI): Promise<void> {
    const plugin = this.plugins.get(name);
    if (!plugin) throw new Error(`Plugin not found: ${name}`);

    const effectiveApi: PluginAPI = api ?? {
      registerTool: (tool: ITool) => this.toolRegistry?.register(tool),
      registerSkill: (skill: SkillDefinition) => this.skillRegistry?.register(skill),
      getWorkingDirectory: () => this.workingDirectory ?? process.cwd(),
      log: (message, level = "info") => {
        console[level](`[Plugin:${name}] ${message}`);
      },
    };

    await plugin.activate(effectiveApi);
  }

  async deactivatePlugin(name: string): Promise<void> {
    const plugin = this.plugins.get(name);
    if (plugin) {
      await plugin.deactivate();
    }
  }

  getPlugin(name: string): IPlugin | undefined {
    return this.plugins.get(name);
  }

  listPlugins(): IPlugin[] {
    return Array.from(this.plugins.values());
  }

  async loadFromDirectory(dirPath: string): Promise<IPlugin> {
    const manifestPath = join(dirPath, "manifest.json");
    const manifestContent = await readFile(manifestPath, "utf-8");
    const manifest: PluginManifest = JSON.parse(manifestContent);

    return this.create(manifest);
  }

  create(manifest: PluginManifest): IPlugin {
    const self = this;
    return {
      manifest,
      loaded: false,
      async load() {
        // Dynamically import the plugin's main module
        const mod = await import(manifest.main);
        if (mod.default && typeof mod.default === "object") {
          Object.assign(this, mod.default);
        }
        (this as { loaded: boolean }).loaded = true;
      },
      async activate(api: PluginAPI) {
        const self = this as unknown as Record<string, unknown>;
        if (typeof self.activate === "function") {
          await self.activate(api);
        }
      },
      async deactivate() {
        const pluginObj = this as unknown as Record<string, unknown>;
        if (typeof pluginObj.deactivate === "function") {
          await pluginObj.deactivate();
        }
        self.plugins.delete(manifest.name);
      },
    };
  }

  async scanDirectory(dirPath: string): Promise<string[]> {
    const found: string[] = [];
    try {
      const entries = await readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const manifestPath = join(dirPath, entry.name, "manifest.json");
        try {
          await stat(manifestPath);
          found.push(join(dirPath, entry.name));
        } catch {
          // no manifest
        }
      }
    } catch {
      // directory doesn't exist
    }
    return found;
  }
}
