import type { SkillDefinition } from '../domain/skill/entities.js';
export declare class SQLiteSkillStore {
    private readonly baseDir;
    constructor(baseDir: string);
    get(name: string): Promise<SkillDefinition | null>;
    save(skill: SkillDefinition): Promise<void>;
    delete(name: string): Promise<void>;
    list(): Promise<SkillDefinition[]>;
    listAll(): Promise<SkillDefinition[]>;
    setEnabled(name: string, enabled: boolean): Promise<void>;
    private rowToSkill;
}
//# sourceMappingURL=SQLiteSkillStore.d.ts.map