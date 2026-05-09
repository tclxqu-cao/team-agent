import type { ISkillLoader, ISkillRegistry, SkillDefinition, SkillMeta } from './entities.js';

export class SkillRegistry implements ISkillRegistry {
  private readonly skills = new Map<string, SkillMeta>();
  /** Cache of loaded prompt bodies keyed by skill name */
  private readonly promptCache = new Map<string, string>();

  constructor(private readonly loader?: ISkillLoader) {}

  register(skill: SkillMeta): void {
    this.skills.set(skill.name, skill);
    // Cache prompt immediately if a full SkillDefinition is registered
    if ("prompt" in skill) {
      this.promptCache.set(skill.name, (skill as SkillDefinition).prompt);
    }
  }

  unregister(name: string): void {
    this.skills.delete(name);
    this.promptCache.delete(name);
  }

  get(name: string): SkillMeta | undefined {
    return this.skills.get(name);
  }

  getAll(): SkillMeta[] {
    return Array.from(this.skills.values());
  }

  findMatching(input: string): SkillMeta[] {
    const lowerInput = input.toLowerCase();
    const matched: SkillMeta[] = [];

    for (const skill of this.skills.values()) {
      for (const trigger of skill.triggers) {
        if (lowerInput.includes(trigger.toLowerCase())) {
          matched.push(skill);
          break;
        }
      }
    }

    return matched;
  }

  async getSkillPrompts(input: string): Promise<string> {
    const matched = this.findMatching(input);
    if (matched.length === 0) return "";

    const parts = await Promise.all(
      matched.map(async (s) => {
        let prompt = this.promptCache.get(s.name);
        if (prompt === undefined && this.loader) {
          const full = await this.loader.loadFromFile(s.filePath);
          prompt = full.prompt;
          this.promptCache.set(s.name, prompt);
        }
        return prompt ? `## Skill: ${s.name}\n${prompt}` : null;
      }),
    );

    return parts.filter(Boolean).join("\n\n");
  }
}
