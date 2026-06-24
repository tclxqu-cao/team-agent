// ── Skill Domain ──

/** Where a skill was discovered from */
export type SkillSource =
  | 'project'   // <projectDir>/.agent/skills/
  | 'global'    // ~/.agent/skills/
  | 'claude'    // ~/.claude/skills/ or <project>/.claude/skills/
  | 'cursor'    // ~/.cursor/skills/ or <project>/.cursor/skills/
  | 'github'    // ~/.github/skills/ or <project>/.github/skills/
  | 'codex'     // ~/.codex/skills/ or <project>/.codex/skills/
  | 'copilot'   // ~/.copilot/skills/ or <project>/.copilot/skills/
  | 'custom';   // explicitly set via withSkillsDirectory()

/** Lightweight metadata loaded upfront (no prompt body) */
export interface SkillMeta {
  name: string;
  description: string;
  triggers: string[];
  tools?: string[];
  filePath: string;
  /** Origin of the skill — useful for display and deduplication priority */
  source: SkillSource;
}

/** Full skill with prompt body — loaded on demand */
export interface SkillDefinition extends SkillMeta {
  prompt: string;
}

export interface ISkillLoader {
  /** Load skill metadata from a directory (frontmatter only, no prompt body) */
  loadFromDirectory(dirPath: string, source?: SkillSource): Promise<SkillMeta[]>;
  /** Load a single skill including its full prompt body */
  loadFromFile(filePath: string): Promise<SkillDefinition>;
  /**
   * Auto-discover skills from all known locations in priority order:
   * project (.agent/skills) → global (~/.agent/skills) →
   * project third-party (.claude, .cursor, .github, .codex, .copilot) →
   * global third-party
   * Skills with duplicate names are resolved by the first (highest priority) occurrence.
   */
  loadAll(projectDir: string): Promise<SkillMeta[]>;
  /**
   * Install a skill into a target skills directory by copying its source.
   * sourcePath can be:
   *   - a directory containing SKILL.md
   *   - a path directly to a SKILL.md file
   * The skill is copied to `<targetSkillsDir>/<skillName>/SKILL.md`.
   * Returns the installed skill metadata.
   */
  installSkill(sourcePath: string, targetSkillsDir: string): Promise<SkillMeta>;
}

export interface ISkillRegistry {
  register(skill: SkillMeta): void;
  unregister(name: string): void;
  get(name: string): SkillMeta | undefined;
  getAll(): SkillMeta[];
  /** Find skills triggered by user input */
  findMatching(input: string): SkillMeta[];
  /** Get assembled prompt text for matched skills (lazy-loads prompt bodies).
   *  If enabledSkills is provided, only skills in that list can be activated. */
  getSkillPrompts(input: string, enabledSkills?: string[] | null): Promise<string>;
  /** Inject a model provider to enable LLM-based semantic matching */
  setModelProvider(provider: import('../model/entities.js').IModelProvider | null): void;
}
