import { todoServices } from "../../../lib/todo/todo-service";
import { todoHttpError, todoOwner, todoWrite } from "../../../lib/todo/todo-http";
import type { TodoListQuery } from "@agent/core";
export const dynamic = "force-dynamic";
export async function GET(request: Request) { try { const q = Object.fromEntries(new URL(request.url).searchParams) as TodoListQuery; return Response.json(todoServices().todos.list(q, todoOwner(request))); } catch (e) { return todoHttpError(e); } }
export const POST = (request: Request) => todoWrite(request);
