import { getDatabase } from "@agent/core";
import { getServerBaseDir } from "./server-data-dir";

/** Small revision projection; do not load transcripts on every watcher tick. */
export function customerSessionChanges(request: Request, id: string): Response {
  const db = getDatabase(getServerBaseDir()).db;
  const read = db.prepare(`SELECT updated, status,
    (SELECT MAX(id) FROM events WHERE session_id = sessions.id) AS eventId,
    (SELECT MAX(id) FROM messages WHERE session_id = sessions.id) AS messageId
    FROM sessions WHERE id = ?`);
  let previous = JSON.stringify(read.get(id));
  if (previous === undefined) return Response.json({ error: "Session not found" }, { status: 404 });
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const encoder = new TextEncoder();
      const timer = setInterval(() => {
        if (closed) return;
        try {
          const revision = JSON.stringify(read.get(id));
          if (revision !== previous) {
            previous = revision;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "session_history_changed", revision: Date.now() })}\n\n`));
          } else controller.enqueue(encoder.encode(": keep-alive\n\n"));
        } catch { cleanup(); try { controller.close(); } catch {} }
      }, 1000);
      cleanup = () => { if (closed) return; closed = true; clearInterval(timer); request.signal.removeEventListener("abort", cleanup); };
      request.signal.addEventListener("abort", cleanup, { once: true });
      if (request.signal.aborted) cleanup();
      else controller.enqueue(encoder.encode(": connected\n\n"));
    },
    cancel() { cleanup(); },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" } });
}
