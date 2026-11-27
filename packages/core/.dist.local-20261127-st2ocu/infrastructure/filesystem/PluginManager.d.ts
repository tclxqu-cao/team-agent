import type { IPluginManager, IPlugin, IPluginLoader, PluginManifest, PluginAPI } from '../../domain/plugin/entities.js';
import type { IToolRegistry } from '../../domain/tool/entities.js';
import type { ISkillRegistry } from '../../domain/skill/entities.js';
export declare class PluginManager implements IPluginManager, IPluginLoader {
    private readonly toolRegistry?;
    private readonly skillRegistry?;
    private readonly workingDirectory?;
    private readonly plugins;
    constructor(toolRegistry?: IToolRegistry | undefined, skillRegistry?: ISkillRegistry | undefined, workingDirectory?: string | undefined);
    loadPlugin(dirPath: string): Promise<IPlugin>;
    unloadPlugin(name: string): Promise<void>;
    activatePlugin(name: string, api?: PluginAPI): Promise<void>;
    deactivatePlugin(name: string): Promise<void>;
    getPlugin(name: string): IPlugin | undefined;
    listPlugins(): IPlugin[];
    loadFromDirectory(dirPath: string): Promise<IPlugin>;
    create(manifest: PluginManifest): IPlugin;
    scanDirectory(dirPath: string): Promise<string[]>;
}
//# sourceMappingURL=PluginManager.d.ts.map