import { checkSharedWrite } from "../../../../lib/shared-write-request";
import {
  knownToolIds,
  toolExecutionPolicies,
  toolPolicyErrorResponse,
} from "../../../../lib/tool-execution-policies";

type RouteContext = { params: { policyId: string } };

export async function PUT(request: Request, { params }: RouteContext) {
  const rejected = checkSharedWrite(request);
  if (rejected) return rejected;
  try {
    if (!await toolExecutionPolicies().get(params.policyId)) {
      return Response.json({ error: "Tool policy not found", code: "TOOL_POLICY_NOT_FOUND" }, { status: 404 });
    }
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return Response.json({ error: "Tool policy must be an object", code: "INVALID_TOOL_POLICY" }, { status: 422 });
    }
    if ("id" in body && body.id !== params.policyId) {
      return Response.json({ error: "Tool policy ID cannot be changed", code: "INVALID_TOOL_POLICY" }, { status: 422 });
    }
    return Response.json(await toolExecutionPolicies().save(
      { ...body, id: params.policyId },
      knownToolIds(),
    ));
  } catch (error) {
    return toolPolicyErrorResponse(error);
  }
}

export async function DELETE(request: Request, { params }: RouteContext) {
  const rejected = checkSharedWrite(request);
  if (rejected) return rejected;
  if (!await toolExecutionPolicies().delete(params.policyId)) {
    return Response.json({ error: "Tool policy not found", code: "TOOL_POLICY_NOT_FOUND" }, { status: 404 });
  }
  return Response.json({ deleted: true, policyId: params.policyId });
}
