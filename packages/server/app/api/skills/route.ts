import { NextResponse } from "next/server";
import { SkillLoader } from "@agent/core";
import { businessCatalog } from "../../../lib/business-catalog";

export async function GET() {
  const skills = await businessCatalog().call("listSkills", []) as Array<{ name: string; description: string; triggers: string[]; filePath: string }>;
  return NextResponse.json(
    skills.map((s) => ({
      name: s.name,
      description: s.description,
      triggers: s.triggers,
      filePath: s.filePath,
    })),
  );
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { filePath?: string; dirPath?: string };
    const loader = new SkillLoader();
    const registry = businessCatalog().skills;

    let imported: Array<{ name: string; description: string }> = [];

    if (body.filePath) {
      // Import a single SKILL.md file
      const skill = await loader.loadFromFile(body.filePath);
      await registry.save(skill);
      imported.push({ name: skill.name, description: skill.description });
    } else if (body.dirPath) {
      // Import all SKILL.md files from a directory
      const skills = await loader.loadFromDirectory(body.dirPath);
      for (const skill of skills) {
        await registry.save(await loader.loadFromFile(skill.filePath));
        imported.push({ name: skill.name, description: skill.description });
      }
    } else {
      return NextResponse.json(
        { error: "filePath or dirPath is required" },
        { status: 400 },
      );
    }

    return NextResponse.json({
      status: "imported",
      count: imported.length,
      skills: imported,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Skill import failed" },
      { status: 500 },
    );
  }
}
