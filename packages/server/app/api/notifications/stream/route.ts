import { todoServices } from "../../../../lib/todo/todo-service";
import { todoOwner, todoHttpError } from "../../../../lib/todo/todo-http";
import { todoServiceId } from "../../../../lib/todo/todo-mcp-credentials";
import { sharedSettings } from "../../../../lib/shared-settings";
import { resolveTaskNotificationPreferences } from "@agent/core";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const ownerId = todoOwner(request), deviceId = request.headers.get("x-agentroam-device-id")!;
    let after = Number(request.headers.get("last-event-id")) || 0;
    const encoder = new TextEncoder(); let timer: ReturnType<typeof setInterval> | undefined;
    const body = new ReadableStream({ start(controller) {
      const send = () => { try { const batch = todoServices().notifications.claim(ownerId, deviceId, after); if (batch.items.length || batch.cursor > after) { controller.enqueue(encoder.encode(`id: ${batch.cursor}\ndata: ${JSON.stringify({ ...batch, serviceId: todoServiceId(), ownerId, preferences: resolveTaskNotificationPreferences(sharedSettings().read().taskNotifications) })}\n\n`)); after = batch.cursor; } else controller.enqueue(encoder.encode(": heartbeat\n\n")); } catch { if (timer) clearInterval(timer); controller.close(); } };
      timer = setInterval(send, 3000); send(); request.signal.addEventListener("abort", () => { if (timer) clearInterval(timer); try { controller.close(); } catch {} }, { once: true });
    }, cancel() { if (timer) clearInterval(timer); } });
    return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", "connection": "keep-alive" } });
  } catch (e) { return todoHttpError(e); }
}
