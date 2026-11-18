import { todoServices } from "../../../../lib/todo/todo-service";
import { todoOwner, todoHttpError } from "../../../../lib/todo/todo-http";
export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: { id: string } }) { try { return Response.json(todoServices().notifications.get(todoOwner(request), params.id)); } catch (e) { return todoHttpError(e); } }
