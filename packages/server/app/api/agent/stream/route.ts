import { agentHost } from "../../agent-host";
import {
  getNativeRuntimeService,
  isNativeSessionId,
} from "../../../../lib/native-runtime-service";
import { ensurePushHook } from "../../../../lib/push-hook";

export async function GET(request: Request) {
  ensurePushHook();
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("sessionId");

  if (!sessionId) {
    return new Response("sessionId is required", { status: 400 });
  }

  if (isNativeSessionId(sessionId)) {
    return nativeStream(request, sessionId);
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
      const url = new URL(request.url);
      const parsedQueryEventId = Number.parseInt(url.searchParams.get("afterEventId") ?? "", 10);
      // A refreshed active session replays its current run. A pre-run stream
      // still follows only future events so an old terminal event cannot close
      // the connection before admission.
      const lastEventId = Number.isSafeInteger(parsedLastEventId)
        ? parsedLastEventId
        : Number.isSafeInteger(parsedQueryEventId)
          ? parsedQueryEventId
          : agentHost.isSessionRunning(sessionId)
            ? 0
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

async function nativeStream(request: Request, sessionId: string): Promise<Response> {
  let streamDone = false;
  let unsubscribe: (() => void) | null = null;
  let abortListener: (() => void) | null = null;
  const service = getNativeRuntimeService();
  const url = new URL(request.url);
  const fromQuery = Number.parseInt(url.searchParams.get("afterSequence") ?? "", 10);
  const fromQueryRunId = url.searchParams.get("afterRunId");
  const lastEventId = request.headers.get("last-event-id");

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const finish = () => {
        if (streamDone) return;
        streamDone = true;
        unsubscribe?.();
        unsubscribe = null;
        if (abortListener) request.signal.removeEventListener("abort", abortListener);
        try { controller.close(); } catch { /* already closed */ }
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

      if (!push(": connected\n\n")) return;
      try {
        const snapshot = await service.snapshot(sessionId);
        const headerCursor = parseNativeEventCursor(lastEventId);
        const queryCursor = Number.isSafeInteger(fromQuery)
          ? { runId: fromQueryRunId, sequence: fromQuery }
          : null;
        const cursor = headerCursor ?? queryCursor;
        // A first EventSource connection follows only future native events.
        // A cursor from another run must replay the new run from its beginning
        // because run-local sequence numbers restart at one.
        const afterSequence = cursor
          ? (!cursor.runId || cursor.runId === snapshot.runId ? cursor.sequence : 0)
          : snapshot.snapshotRevision;
        unsubscribe = await service.subscribe(sessionId, afterSequence, ({ runId, sequence, event }) => {
          const payload = { ...event, _nativeRunId: runId, _nativeSequence: sequence };
          if (!push(`id: ${runId}:${sequence}\ndata: ${JSON.stringify(payload)}\n\n`)) return;
          if (event.type === "done" || event.type === "error") finish();
        });
        abortListener = finish;
        if (request.signal.aborted) finish();
        else request.signal.addEventListener("abort", abortListener, { once: true });
      } catch (error) {
        push(`event: error\ndata: ${JSON.stringify({ type: "error", message: error instanceof Error ? error.message : "Native stream failed" })}\n\n`);
        finish();
      }
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

function parseNativeEventCursor(value: string | null): { runId: string | null; sequence: number } | null {
  if (!value) return null;
  const separator = value.lastIndexOf(":");
  if (separator < 0) {
    const sequence = Number.parseInt(value, 10);
    return Number.isSafeInteger(sequence) ? { runId: null, sequence } : null;
  }
  const runId = value.slice(0, separator);
  const sequence = Number.parseInt(value.slice(separator + 1), 10);
  return runId && Number.isSafeInteger(sequence) ? { runId, sequence } : null;
}
