import { NextResponse } from "next/server";
import { PluginManager } from "@agent/core";
import { agentHost } from "../../agent-host";

const pluginManager = new PluginManager(
  agentHost.getBuilder().getToolRegistry(),
  agentHost.getBuilder().getSkillRegistry(),
  process.cwd(),
);

export async function POST(request: Request) {
  try {
    const body = await request.json() as { dirPath: string };
    if (!body.dirPath) {
      return NextResponse.json({ error: "dirPath is required" }, { status: 400 });
    }
    const plugin = await pluginManager.loadPlugin(body.dirPath);
    await pluginManager.activatePlugin(plugin.manifest.name);
    return NextResponse.json({
      status: "loaded",
      plugin: {
        name: plugin.manifest.name,
        version: plugin.manifest.version,
        description: plugin.manifest.description,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Plugin load failed" },
      { status: 500 },
    );
  }
}
