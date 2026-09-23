import { agentHost } from "../../../../../agent-host";
import {
  assertFlowAuthorized,
  flowErrorResponse,
  flowRun,
} from "../../../../../../../lib/flow-protocol";

export async function POST(request: Request, { params }: { params: { runId: string } }) {
  try {
    assertFlowAuthorized(request);
    const run = flowRun(params.runId);
    if (!agentHost.isSessionRunning(run.sessionId)) {
      return Response.json({ error: "Flow protocol run is not active", code: "RUN_NOT_ACTIVE" }, { status: 409 });
    }
    agentHost.abort(run.sessionId);
    return Response.json({ ok: true, runId: run.runId });
  } catch (error) {
    return flowErrorResponse(error);
  }
}
