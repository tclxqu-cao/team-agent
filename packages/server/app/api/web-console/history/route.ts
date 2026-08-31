import { anonymousPrincipal, webConsoleStore } from "../../../../lib/web-auth/anonymous";

export async function GET(request: Request) {
  const { userId } = anonymousPrincipal();
  const url = new URL(request.url);
  return Response.json({
    history: webConsoleStore.listHistory(
      userId,
      url.searchParams.get("q") || "",
      Math.min(200, Number(url.searchParams.get("limit") || 100)),
      url.searchParams.get("terminalId") || undefined,
    ),
  });
}

export async function DELETE(request: Request) {
  const { userId } = anonymousPrincipal();
  const body = await request.json();
  if (body.id) webConsoleStore.deleteHistory(userId, Number(body.id));
  else webConsoleStore.clearHistory(userId, body.terminalId || undefined);
  return new Response(null, { status: 204 });
}
