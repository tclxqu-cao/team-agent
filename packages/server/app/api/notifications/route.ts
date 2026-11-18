import { todoServices } from "../../../lib/todo/todo-service";
import { todoOwner, todoHttpError } from "../../../lib/todo/todo-http";
import { sharedSettings } from "../../../lib/shared-settings";
import { resolveTaskNotificationPreferences } from "@agent/core";
import { todoServiceId } from "../../../lib/todo/todo-mcp-credentials";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try { const ownerId = todoOwner(request); return Response.json({ items: todoServices().notifications.list(ownerId, Number(new URL(request.url).searchParams.get("after")) || 0), serviceId: todoServiceId(), ownerId, preferences: resolveTaskNotificationPreferences(sharedSettings().read().taskNotifications) }); }
  catch (e) { return todoHttpError(e); }
}
