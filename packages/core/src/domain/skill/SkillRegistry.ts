import type { ISkillLoader, ISkillRegistry, SkillDefinition, SkillMeta } from './entities.js';
import type { IModelProvider, Message } from '../model/entities.js';

export class SkillRegistry implements ISkillRegistry {
  private readonly skills = new Map<string, SkillMeta>();
  /** Cache of loaded prompt bodies keyed by skill name */
  private readonly promptCache = new Map<string, string>();
  /** Cache of semantic match results keyed by input hash */
  private readonly semanticCache = new Map<string, SkillMeta[]>();
  /** Optional model provider for semantic matching */
  private modelProvider: IModelProvider | null = null;
  /** LLM fallback is enabled by default for backward compatibility. */
  private semanticMatchingEnabled = true;

  constructor(private readonly loader?: ISkillLoader) {}

  /** Inject a model provider to enable LLM-based semantic matching */
  setModelProvider(provider: IModelProvider | null): void {
    this.modelProvider = provider;
    // Clear cache when provider changes
    this.semanticCache.clear();
  }

  setSemanticMatchingEnabled(enabled: boolean): void {
    this.semanticMatchingEnabled = enabled;
    this.semanticCache.clear();
  }

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
    return this.findMatchingFrom(input, this.skills.values());
  }

  private findMatchingFrom(input: string, skills: Iterable<SkillMeta>): SkillMeta[] {
    const lowerInput = input.toLowerCase();
    const matched: SkillMeta[] = [];

    for (const skill of skills) {
      for (const trigger of skill.triggers) {
        if (lowerInput.includes(trigger.toLowerCase())) {
          matched.push(skill);
          break;
        }
      }
    }

    return matched;
  }

  /**
   * Semantic matching using the configured LLM.
   * Sends all skill names + descriptions to the model and asks which are
   * semantically relevant to the user's input.
   * Returns matched skills or empty array on failure.
   */
  private async findMatchingSemantic(input: string, candidates: SkillMeta[]): Promise<SkillMeta[]> {
    if (!this.modelProvider || candidates.length === 0) return [];

    // Check cache
    const candidateKey = candidates.map((skill) => skill.name).sort().join("\u0000");
    const cacheKey = `${input.trim().slice(0, 200)}\u0001${candidateKey}`;
    const cached = this.semanticCache.get(cacheKey);
    if (cached) return cached;

    // Build skill list for the prompt
    const skillList = candidates
      .map((s, i) => `${i + 1}. ${s.name}: ${s.description || '(no description)'}`)
      .join('\n');

    const matchPrompt = `You are a skill matching assistant. Given the user's input and a list of available skills with their descriptions, determine which skills are semantically relevant to the user's request.

Available skills:
${skillList}

User input: "${input}"

Return ONLY the names of relevant skills, one per line. If none are relevant, return "NONE". Do not include any other text, explanation, or numbering.`;

    const messages: Message[] = [
      { role: 'user', content: matchPrompt },
    ];

    try {
      // Consume the stream to collect full response text
      let responseText = '';
      for await (const event of this.modelProvider.streamChat(messages, {
        temperature: 0,
        maxTokens: 200,
        reasoningEffort: "off",
      })) {
        if (event.type === 'text_chunk') {
          responseText += event.text;
        }
        if (event.type === 'error') {
          return [];
        }
      }

      const trimmed = responseText.trim();
      if (!trimmed || trimmed.toUpperCase() === 'NONE') {
        this.semanticCache.set(cacheKey, []);
        return [];
      }

      // Parse skill names from response (one per line, strip numbering/punctuation)
      const names = trimmed
        .split('\n')
        .map((line) => line.replace(/^\d+\.\s*/, '').replace(/^[\s\-•*]+/, '').trim())
        .filter(Boolean);

      const matched: SkillMeta[] = [];
      const candidatesByName = new Map(candidates.map((skill) => [skill.name, skill]));
      for (const name of names) {
        const skill = candidatesByName.get(name);
        if (skill && !matched.find((m) => m.name === skill.name)) {
          matched.push(skill);
        }
      }

      this.semanticCache.set(cacheKey, matched);
      return matched;
    } catch {
      // On any error, fall back gracefully
      return [];
    }
  }

  async getSkillPrompts(input: string, enabledSkills?: string[] | null): Promise<string> {
    const allowed = enabledSkills && enabledSkills.length > 0
      ? new Set(enabledSkills)
      : null;
    const eligibleSkills = Array.from(this.skills.values()).filter(
      (skill) => !allowed || allowed.has(skill.name),
    );

    // 1. Try trigger-based keyword matching (fast path)
    let matched = this.findMatchingFrom(input, eligibleSkills);
  
    // 2. If input is /skill-name, also try direct name lookup
    const slashMatch = input.match(/^\/([\w-]+)/);
    if (slashMatch) {
      const byName = eligibleSkills.find((skill) => skill.name === slashMatch[1]);
      if (byName && !matched.find((m) => m.name === byName.name)) {
        matched.unshift(byName);
      }
    }
  
    // 3. If keyword matching found nothing, try LLM-based semantic matching
    if (matched.length === 0 && this.semanticMatchingEnabled && eligibleSkills.length > 0) {
      const semanticMatches = await this.findMatchingSemantic(input, eligibleSkills);
      if (semanticMatches.length > 0) {
        matched = semanticMatches;
      }
    }
  
    if (matched.length === 0) return "";
  
    const parts: string[] = [];
    for (const s of matched) {
      let prompt = this.promptCache.get(s.name);
      if (prompt === undefined && this.loader) {
        const full = await this.loader.loadFromFile(s.filePath);
        prompt = full.prompt;
        this.promptCache.set(s.name, prompt);
      }
      if (prompt) {
        parts.push(`## Skill: ${s.name}\n${prompt}`);
      }
    }
  
    return parts.join("\n\n");
  }
}
