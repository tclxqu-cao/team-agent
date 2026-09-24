import { existsSync } from "node:fs";
import { parse, resolve } from "node:path";
import { SkillLoader, type SkillDefinition } from "@agent/core";

export function configuredSkillsDirectory(
  env: NodeJS.ProcessEnv = process.env,
  startDirectory: string = process.cwd(),
): string {
  const configured = env.AGENT_SKILLS_DIR?.trim() || env.PORTFOLIO_SKILLS_DIR?.trim();
  if (configured) return resolve(configured);
  let directory = resolve(startDirectory);
  const root = parse(directory).root;
  while (true) {
    const candidate = resolve(directory, ".agent", "skills");
    if (existsSync(candidate)) return candidate;
    if (directory === root) return resolve(startDirectory, ".agent", "skills");
    directory = resolve(directory, "..");
  }
}

export async function loadConfiguredSkills(
  directory: string = configuredSkillsDirectory(),
  loader: SkillLoader = new SkillLoader(),
): Promise<SkillDefinition[]> {
  const metadata = (await loader.loadFromDirectory(directory, "project"))
    .sort((left, right) => left.name.localeCompare(right.name));
  return Promise.all(metadata.map((skill) => loader.loadFromFile(skill.filePath)));
}
