import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configuredSkillsDirectory, loadConfiguredSkills } from "./configured-skill-catalog";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "configured-skills-"));
  roots.push(root);
  return root;
}

async function writeSkill(root: string, name: string, prompt: string): Promise<void> {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), [
    "---",
    `name: ${name}`,
    `description: ${name} description`,
    "---",
    prompt,
  ].join("\n"));
}

describe("configured Skill catalog", () => {
  it("loads every valid Skill from the configured directory without name-specific filtering", async () => {
    const root = await tempRoot();
    await writeSkill(root, "alpha", "Alpha prompt.");
    await writeSkill(root, "wiki-query", "Wiki prompt.");
    await writeSkill(root, "zeta", "Zeta prompt.");

    const skills = await loadConfiguredSkills(root);

    expect(skills.map((skill) => skill.name)).toEqual(["alpha", "wiki-query", "zeta"]);
    expect(skills.find((skill) => skill.name === "alpha")).toMatchObject({
      name: "alpha",
      prompt: "Alpha prompt.",
      source: "custom",
      filePath: join(root, "alpha", "SKILL.md"),
    });
  });

  it("uses AGENT_SKILLS_DIR before the legacy directory setting", () => {
    expect(configuredSkillsDirectory({
      AGENT_SKILLS_DIR: "/generic/skills",
      PORTFOLIO_SKILLS_DIR: "/legacy/skills",
    }, "/repo/packages/server")).toBe("/generic/skills");
  });

  it("retains PORTFOLIO_SKILLS_DIR as a compatibility fallback", () => {
    expect(configuredSkillsDirectory({
      PORTFOLIO_SKILLS_DIR: "/legacy/skills",
    }, "/repo/packages/server")).toBe("/legacy/skills");
  });

  it("discovers the nearest repository Skill directory", async () => {
    const root = await tempRoot();
    const nested = join(root, "packages", "server");
    await mkdir(join(root, ".agent", "skills"), { recursive: true });
    await mkdir(nested, { recursive: true });

    expect(configuredSkillsDirectory({}, nested)).toBe(join(root, ".agent", "skills"));
  });
});
