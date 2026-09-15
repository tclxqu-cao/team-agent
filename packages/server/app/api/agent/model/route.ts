import { resumeCustomerQueues } from "../../../../lib/customer-goal-service";
import { resumeThreadGoals } from "../../../../lib/thread-goal-service";
import { NextResponse } from "next/server";
import { agentHost } from "../../agent-host";

export const dynamic = "force-dynamic";

/** Active model info for the web settings panel (key never exposed). */
export async function GET() {
  resumeCustomerQueues();
  resumeThreadGoals();
  return NextResponse.json({
    ...agentHost.getModelConfig(),
    buildId: agentHost.getWebAppBuildId(),
  }, {
    headers: { "cache-control": "no-store" },
  });
}
