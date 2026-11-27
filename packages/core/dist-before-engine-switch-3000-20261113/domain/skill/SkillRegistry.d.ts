import type { ISkillLoader, ISkillRegistry, SkillDefinition, SkillMeta } from './entities.js';
import type { IModelProvider, ToolDefinition } from '../model/entities.js';
export declare class SkillRegistry implements ISkillRegistry {
    private readonly loader?;
    private readonly skills;
    /** Cache of loaded prompt bodies keyed by skill name */
    private readonly promptCache;
    /** Cache of semantic match results keyed by input hash */
    private readonly semanticCache;
    /** Optional model provider for semantic matching */
    private modelProvider;
    /** LLM fallback is enabled by default for backward compatibility. */
    private semanticMatchingEnabled;
    constructor(loader?: ISkillLoader | undefined);
    /** Inject a model provider to enable LLM-based semantic matching */
    setModelProvider(provider: IModelProvider | null): void;
    setSemanticMatchingEnabled(enabled: boolean): void;
    register(skill: SkillMeta): void;
    unregister(name: string): void;
    get(name: string): SkillMeta | undefined;
    getAll(): SkillMeta[];
    discover(query: string, enabledSkills?: string[] | null): SkillMeta[];
    load(name: string, enabledSkills?: string[] | null): Promise<SkillDefinition | null>;
    findMatching(input: string): SkillMeta[];
    private findMatchingFrom;
    /**
     * Semantic matching using the configured LLM.
     * Sends all skill names + descriptions to the model and asks which are
     * semantically relevant to the user's input.
     * Returns matched skills or empty array on failure.
     */
    private findMatchingSemantic;
    getSkillPrompts(input: string, enabledSkills?: string[] | null, modelContext?: {
        workingDirectory?: string;
        tools?: ToolDefinition[];
    }): Promise<string>;
}
//# sourceMappingURL=SkillRegistry.d.ts.map