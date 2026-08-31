import { WEB_ANON_USER_ID, webConsoleStore } from "../../../../lib/web-auth/anonymous";

export async function GET(request: Request) {
  const url = new URL(request.url);
  return Response.json({
    history: webConsoleStore.listHistory(
      WEB_ANON_USER_ID,
      url.searchParams.get("q") || "",
      Math.min(200, Number(url.searchParams.get("limit") || 100)),
      url.searchParams.get("terminalId") || undefined,
    ),
  });
}

export async function DELETE(request: Request) {
  const body = await request.json();
  if (body.id) webConsoleStore.deleteHistory(WEB_ANON_USER_ID, Number(body.id));
  else webConsoleStore.clearHistory(WEB_ANON_USER_ID, body.terminalId || undefined);
  return new Response(null, { status: 204 });
}
