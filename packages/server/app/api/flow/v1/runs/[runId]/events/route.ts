import { agentHost } from "../../../../../agent-host";
import {
  assertFlowAuthorized,
  flowErrorResponse,
  flowRun,
  mapFlowEvent,
} from "../../../../../../../lib/flow-protocol";

export async function GET(request: Request, { params }: { params: { runId: string } }) {
  try {
    assertFlowAuthorized(request);
    const run = flowRun(params.runId);
    let closed = false;
    let unsubscribe: (() => void) | null = null;
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        const finish = () => {
          if (closed) return;
          closed = true;
          unsubscribe?.();
          try { controller.close(); } catch {}
        };
        const push = (id: number, event: string, data: Record<string, unknown>) => {
          if (closed) return;
          controller.enqueue(encoder.encode(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        };
        const headerId = Number.parseInt(request.headers.get("last-event-id") ?? "", 10);
        const queryId = Number.parseInt(new URL(request.url).searchParams.get("afterEventId") ?? "", 10);
        const lastEventId = Number.isSafeInteger(headerId) ? headerId : Number.isSafeInteger(queryId) ? queryId : -1;
        if (lastEventId < 0) {
          push(0, "run.started", {
            runId: run.runId,
            sessionId: run.sessionId,
            timestamp: new Date().toISOString(),
          });
        }
        unsubscribe = agentHost.subscribe(run.sessionId, (event, id) => {
          const mapped = mapFlowEvent(run.runId, run.sessionId, id, event);
          if (!mapped) return;
          push(mapped.id, mapped.event, mapped.data);
          if (mapped.event === "run.completed" || mapped.event === "run.failed") finish();
        }, Math.max(0, lastEventId));
        if (request.signal.aborted) finish();
        else request.signal.addEventListener("abort", finish, { once: true });
      },
      cancel() {
        closed = true;
        unsubscribe?.();
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  } catch (error) {
    return flowErrorResponse(error);
  }
}
