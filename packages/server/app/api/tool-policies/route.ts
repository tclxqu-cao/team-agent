import { checkSharedWrite } from "../../../lib/shared-write-request";
import {
  knownToolIds,
  toolExecutionPolicies,
  toolPolicyErrorResponse,
} from "../../../lib/tool-execution-policies";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({
    policies: await toolExecutionPolicies().list(),
    tools: knownToolIds(),
  }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  const rejected = checkSharedWrite(request);
  if (rejected) return rejected;
  try {
    const body = await request.json();
    if (body && typeof body === "object" && !Array.isArray(body) && typeof body.id === "string") {
      if (await toolExecutionPolicies().get(body.id.trim())) {
        return Response.json({ error: "Tool policy already exists", code: "TOOL_POLICY_EXISTS" }, { status: 409 });
      }
    }
    return Response.json(await toolExecutionPolicies().save(body, knownToolIds()), { status: 201 });
  } catch (error) {
    return toolPolicyErrorResponse(error);
  }
}
