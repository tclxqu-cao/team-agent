import { todoServices } from "../../../../../lib/todo/todo-service";
import { todoHttpError, todoOwner } from "../../../../../lib/todo/todo-http";
export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: { id: string } }) { try { return Response.json(todoServices().todos.executions(params.id, todoOwner(request), new URL(request.url).searchParams.get("cursor") ?? undefined)); } catch (e) { return todoHttpError(e); } }
