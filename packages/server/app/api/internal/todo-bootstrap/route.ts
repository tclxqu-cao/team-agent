import { startTodoWorkers } from "../../../../lib/todo/bootstrap";
import { todoOwner, todoHttpError } from "../../../../lib/todo/todo-http";
export const dynamic = "force-dynamic";
export async function POST(request: Request) { try { todoOwner(request); startTodoWorkers(); return Response.json({ ok: true }); } catch (e) { return todoHttpError(e); } }
