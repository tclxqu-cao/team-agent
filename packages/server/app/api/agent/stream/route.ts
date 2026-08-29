import { agentHost } from "../../agent-host";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("sessionId");

  if (!sessionId) {
    return new Response("sessionId is required", { status: 400 });
  }

  let streamDone = false;
  let unsubscribe: (() => void) | null = null;
  let abortListener: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const finish = () => {
        if (streamDone) return;
        streamDone = true;
        unsubscribe?.();
        unsubscribe = null;
        if (abortListener) request.signal.removeEventListener("abort", abortListener);
        try { controller.close(); } catch { /* already closed/cancelled */ }
      };
      const push = (data: string): boolean => {
        if (streamDone) return false;
        try {
          controller.enqueue(encoder.encode(data));
          return true;
        } catch {
          finish();
          return false;
        }
      };

      // Handshake MUST be enqueued before subscribe(): subscribe can
      // synchronously replay a buffered terminal event and close the stream.
      if (!push(": connected\n\n")) return;

      const lastEventIdRaw = request.headers.get("last-event-id");
      const parsedLastEventId = Number.parseInt(lastEventIdRaw ?? "", 10);
      // A brand-new EventSource wants only future events; replaying an old
      // terminal event would immediately close the stream before the next run
      // starts. Auto-reconnects carry Last-Event-ID and still replay gaps.
      const lastEventId = Number.isSafeInteger(parsedLastEventId)
        ? parsedLastEventId
        : agentHost.getLatestEventId(sessionId);
      unsubscribe = agentHost.subscribe(
        sessionId,
        (event, id) => {
          if (!push(`id: ${id}\ndata: ${JSON.stringify(event)}\n\n`)) return;
          if (event.type === "done" || event.type === "error") finish();
        },
        lastEventId,
      );

      abortListener = finish;
      if (request.signal.aborted) finish();
      else request.signal.addEventListener("abort", abortListener, { once: true });
    },
    cancel() {
      streamDone = true;
      unsubscribe?.();
      unsubscribe = null;
      if (abortListener) request.signal.removeEventListener("abort", abortListener);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
