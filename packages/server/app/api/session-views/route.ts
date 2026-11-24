import { sessionViewRequest } from "../../../lib/session-view-request";
import { syncSessionViews } from "../../../lib/session-views";

export async function POST(request: Request) {
  const input = sessionViewRequest.safeParse(await request.json().catch(() => null));
  if (!input.success) return Response.json({ error: "会话已读同步参数无效" }, { status: 400 });
  return Response.json(syncSessionViews(input.data.afterRevision, input.data.views));
}
