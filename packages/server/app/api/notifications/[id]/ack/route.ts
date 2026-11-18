import { todoServices } from "../../../../../lib/todo/todo-service";
import { todoOwner, todoHttpError } from "../../../../../lib/todo/todo-http";
import { checkSharedWrite } from "../../../../../lib/shared-write-request";
export const dynamic = "force-dynamic";
export async function POST(request: Request, { params }: { params: { id: string } }) { const rejected = checkSharedWrite(request); if (rejected) return rejected; try { const body = await request.json(); return Response.json(todoServices().notifications.ack(todoOwner(request), params.id, request.headers.get("x-agentroam-device-id")!, body.read === true, body.displayed === true)); } catch (e) { return todoHttpError(e); } }
