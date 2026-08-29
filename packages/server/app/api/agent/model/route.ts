import { NextResponse } from "next/server";
import { agentHost } from "../../agent-host";

/** Active model info for the web settings panel (key never exposed). */
export async function GET() {
  return NextResponse.json({
    ...agentHost.getModelConfig(),
    buildId: agentHost.getWebAppBuildId(),
  });
}
