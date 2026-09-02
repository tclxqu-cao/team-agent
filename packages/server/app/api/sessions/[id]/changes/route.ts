import {
  getNativeRuntimeService,
  isNativeSessionId,
  runtimeErrorStatus,
} from "../../../../../lib/native-runtime-service";
import { getNativeSessionChangeMonitor } from "../../../../../lib/native-session-change-monitor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const encoder = new TextEncoder();

export async function GET(
  request: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  if (!isNativeSessionId(params.id)) {
    return Response.json({ error: "Native session not found" }, { status: 404 });
  }

  try {
    const path = await getNativeRuntimeService().getSessionWatchPath(params.id);
    if (!path) {
      return Response.json({ error: "Native session transcript is unavailable" }, { status: 404 });
    }

    let cleanup = () => undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        const unsubscribe = getNativeSessionChangeMonitor().subscribe(
          params.id,
          path,
          (change) => {
            if (!closed) controller.enqueue(encoder.encode(`data: ${JSON.stringify(change)}\n\n`));
          },
        );
        const keepAlive = setInterval(() => {
          if (!closed) controller.enqueue(encoder.encode(": keep-alive\n\n"));
        }, 15_000);
        cleanup = () => {
          if (closed) return;
          closed = true;
          clearInterval(keepAlive);
          unsubscribe();
          request.signal.removeEventListener("abort", cleanup);
        };
        request.signal.addEventListener("abort", cleanup, { once: true });
        controller.enqueue(encoder.encode(": connected\n\n"));
      },
      cancel() {
        cleanup();
      },
    });

    return new Response(stream, {
      headers: {
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream; charset=utf-8",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Internal error" },
      { status: runtimeErrorStatus(error) },
    );
  }
}
