import { todoServices } from "../../../../lib/todo/todo-service";
import { todoHttpError, todoOwner } from "../../../../lib/todo/todo-http";
export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: { id: string } }) { try { return Response.json(todoServices().todos.get(params.id, todoOwner(request))); } catch (e) { return todoHttpError(e); } }
