import { todoWrite } from "../../../../../lib/todo/todo-http";
export const dynamic = "force-dynamic";
export const POST = (request: Request, { params }: { params: { id: string } }) => todoWrite(request, params.id);
