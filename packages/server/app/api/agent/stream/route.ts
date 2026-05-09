import { agentHost } from "../../agent-host";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("sessionId");

  if (!sessionId) {
    return new Response("sessionId is required", { status: 400 });
  }

  let streamDone = false;

  const stream = new ReadableStream({
    start(controller) {
      const unsubscribe = agentHost.subscribe((event) => {
        if (streamDone) return;
        const data = `data: ${JSON.stringify(event)}\n\n`;
        controller.enqueue(new TextEncoder().encode(data));

        if (event.type === "done" || event.type === "error") {
          streamDone = true;
          controller.close();
          unsubscribe();
        }
      });
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
