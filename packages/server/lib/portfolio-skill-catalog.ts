import { existsSync } from "node:fs";
import { dirname, parse, resolve } from "node:path";
import { SkillLoader, type SkillDefinition } from "@agent/core";

export const PORTFOLIO_SKILL_PREFIX = "portfolio-";

export function portfolioSkillsDirectory(
  env: NodeJS.ProcessEnv = process.env,
  startDirectory: string = process.cwd(),
): string {
  const configured = env.PORTFOLIO_SKILLS_DIR?.trim();
  if (configured) return resolve(configured);
  let directory = resolve(startDirectory);
  const root = parse(directory).root;
  while (true) {
    const candidate = resolve(directory, ".agent", "skills");
    if (existsSync(candidate)) return candidate;
    if (directory === root) return resolve(startDirectory, ".agent", "skills");
    directory = dirname(directory);
  }
}

export async function loadPortfolioSkills(
  directory: string = portfolioSkillsDirectory(),
  loader: SkillLoader = new SkillLoader(),
): Promise<SkillDefinition[]> {
  const metadata = (await loader.loadFromDirectory(directory, "project"))
    .filter((skill) => skill.name.startsWith(PORTFOLIO_SKILL_PREFIX))
    .sort((left, right) => left.name.localeCompare(right.name));
  const skills = await Promise.all(metadata.map((skill) => loader.loadFromFile(skill.filePath)));
  if (skills.length === 0) {
    throw new Error(`Portfolio Skills are unavailable in ${directory}`);
  }
  return skills;
}
