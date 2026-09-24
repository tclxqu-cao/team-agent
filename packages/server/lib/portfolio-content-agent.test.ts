import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Project } from "@agent/core";
import {
  ensurePortfolioContentProject,
  PORTFOLIO_CONTENT_PROJECT_ID,
  searchPublicWiki,
} from "./portfolio-content-agent";
import { loadPortfolioSkills, portfolioSkillsDirectory } from "./portfolio-skill-catalog";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "portfolio-public-"));
  roots.push(root);
  return root;
}

describe("Portfolio content Agent catalog", () => {
  it("loads only portfolio Skills from the project Skill directory", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "portfolio-help"));
    await mkdir(join(root, "unrelated"));
    await writeFile(join(root, "portfolio-help", "SKILL.md"), [
      "---",
      "name: portfolio-help",
      "description: Portfolio help",
      "triggers: /help, help",
      "---",
      "Return portfolio help.",
    ].join("\n"));
    await writeFile(join(root, "unrelated", "SKILL.md"), [
      "---",
      "name: unrelated",
      "description: Unrelated",
      "---",
      "Ignore this Skill.",
    ].join("\n"));

    const skills = await loadPortfolioSkills(root);

    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      name: "portfolio-help",
      prompt: "Return portfolio help.",
      source: "custom",
      filePath: join(root, "portfolio-help", "SKILL.md"),
    });
  });

  it("fails clearly when the project Skill directory has no Portfolio Skills", async () => {
    const root = await tempRoot();
    await expect(loadPortfolioSkills(root)).rejects.toThrow(`Portfolio Skills are unavailable in ${root}`);
  });

  it("resolves the repository project Skill directory without a machine-specific path", () => {
    expect(portfolioSkillsDirectory({}, process.cwd()))
      .toBe(join(process.cwd(), ".agent", "skills"));
    expect(portfolioSkillsDirectory({ PORTFOLIO_SKILLS_DIR: "/custom/skills" }, "/repo/packages/server"))
      .toBe("/custom/skills");
  });

  it("keeps the jobs Skill artifact and HTML table contract explicit", async () => {
    const skills = await loadPortfolioSkills(portfolioSkillsDirectory({}, process.cwd()));
    const jobs = skills.find((skill) => skill.name === "portfolio-jobs");

    expect(jobs?.prompt).toContain('"title":"..."');
    expect(jobs?.prompt).toContain('"type":"html"');
    expect(jobs?.prompt).toContain("semantic table");
    expect(jobs?.prompt).toContain("use single quotes for every HTML attribute");
    expect(jobs?.prompt).toContain("never use Markdown link syntax inside `href`");
    expect(jobs?.prompt).toContain("Do not return a Markdown table");
  });

  it("keeps the works Skill as a clickable project index", async () => {
    const skills = await loadPortfolioSkills(portfolioSkillsDirectory({}, process.cwd()));
    const works = skills.find((skill) => skill.name === "portfolio-works");

    expect(works?.prompt).toContain("editorial project index instead of a table");
    expect(works?.prompt).toContain("exactly 10 `button.artifact-flow-step`");
    expect(works?.prompt).toContain("single quotes for every HTML attribute");
    expect(works?.prompt).toContain("data-command='/project PROJECT_ID'");
    expect(works?.prompt).toContain("/project agentroam");
    expect(works?.prompt).toContain("/project kid-earth");
    expect(works?.prompt).toContain("each project's own Skill is responsible for its media");
  });

  it("seeds one stable project so persistent Portfolio sessions are visible", async () => {
    const root = await tempRoot();
    const canonicalRoot = await realpath(root);
    const projects = new Map<string, Project>();
    const store = {
      get: async (id: string) => projects.get(id) ?? null,
      create: async (project: Project) => { projects.set(project.id, project); return project; },
      update: async (id: string, update: Partial<Project>) => {
        const project = { ...projects.get(id)!, ...update, updated: "2026-09-23T00:00:00.000Z" };
        projects.set(id, project);
        return project;
      },
      delete: async (id: string) => { projects.delete(id); },
      list: async () => [...projects.values()],
    };

    const first = await ensurePortfolioContentProject(store, root);
    const second = await ensurePortfolioContentProject(store, root);

    expect(first).toMatchObject({
      id: PORTFOLIO_CONTENT_PROJECT_ID,
      name: "portfolio-public",
      description: canonicalRoot,
    });
    expect(second).toEqual(first);
    expect(projects).toHaveLength(1);
  });
});

describe("Portfolio public Wiki", () => {
  it("returns only Markdown files below the real root and skips symlinks", async () => {
    const root = await tempRoot();
    const outside = join(root, "..", `private-${Date.now()}.md`);
    await writeFile(join(root, "public.md"), "AgentRoam public project workflow", "utf8");
    await writeFile(outside, "AgentRoam private credential", "utf8");
    await symlink(outside, join(root, "linked.md"));
    try {
      const results = await searchPublicWiki(root, "AgentRoam project");
      expect(results).toEqual([expect.objectContaining({ source: "public.md" })]);
      expect(JSON.stringify(results)).not.toContain("credential");
    } finally {
      await rm(outside, { force: true });
    }
  });

  it("rejects a symlink as the configured public root", async () => {
    const root = await tempRoot();
    const link = `${root}-link`;
    roots.push(link);
    await symlink(root, link);
    await expect(searchPublicWiki(link, "project")).rejects.toThrow(/real directory/);
  });
});
