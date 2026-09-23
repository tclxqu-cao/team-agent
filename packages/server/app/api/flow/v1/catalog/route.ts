import {
  assertFlowAuthorized,
  flowCatalog,
  flowErrorResponse,
} from "../../../../../lib/flow-protocol";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    assertFlowAuthorized(request);
    return Response.json(await flowCatalog(), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return flowErrorResponse(error);
  }
}
