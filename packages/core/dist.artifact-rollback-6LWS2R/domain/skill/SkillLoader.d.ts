import type { ISkillLoader, SkillDefinition, SkillMeta, SkillSource } from './entities.js';
export declare class SkillLoader implements ISkillLoader {
    /** Load skill metadata from a directory (frontmatter only, no prompt body) */
    loadFromDirectory(dirPath: string, source?: SkillSource): Promise<SkillMeta[]>;
    /**
     * Auto-discover skills from all known locations in priority order:
     *   1. project:  <projectDir>/.agent/skills/
     *   2. global:   ~/.agent/skills/
     *   3. project third-party: <projectDir>/.<tool>/skills/
     *   4. global  third-party: ~/.<tool>/skills/
     *
     * Duplicate names are resolved by the first (highest-priority) occurrence.
     */
    /** Synchronous variant of loadFromDirectory for Electron */
    loadFromDirectorySync(dirPath: string, source?: SkillSource): SkillMeta[];
    /** Synchronous variant of loadAll for Electron */
    loadAllSync(projectDir: string): SkillMeta[];
    /**
     * Auto-discover skills from all known locations in priority order:
     *   1. project:  <projectDir>/.agent/skills/
     *   2. global:   ~/.agent/skills/
     *   3. global:   ~/.agents/skills/
     *   4. project third-party: <projectDir>/.<tool>/skills/
     *   5. global  third-party: ~/.<tool>/skills/
     *
     * Duplicate names are resolved by the first (highest-priority) occurrence.
     */
    loadAll(projectDir: string): Promise<SkillMeta[]>;
    loadFromFile(filePath: string): Promise<SkillDefinition>;
    /** Synchronous variant of loadFromFile for Electron */
    loadFromFileSync(filePath: string): SkillDefinition;
    /**
     * Install a skill into targetSkillsDir by copying its source.
     * sourcePath may be:
     *   - a directory that contains SKILL.md  → the whole directory is copied
     *   - a path pointing directly to SKILL.md → only that file is copied
     * Destination: <targetSkillsDir>/<skillName>/SKILL.md
     */
    installSkill(sourcePath: string, targetSkillsDir: string): Promise<SkillMeta>;
    private loadMeta;
    /** Parse only the YAML frontmatter block — skips the prompt body */
    private parseFrontmatterOnly;
    private parseSkillMd;
    private inferSource;
}
//# sourceMappingURL=SkillLoader.d.ts.map