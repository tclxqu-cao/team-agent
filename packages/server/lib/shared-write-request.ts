/** Browser writes must originate from this console; desktop requests are
 * authenticated by the outer gateway and do not carry a browser Origin.
 * Capacitor/Ionic native shells (Android/iOS App) load their UI from a local
 * scheme origin that only a native app's WebView can produce — a website
 * cannot fake capacitor:// — so their writes are trusted like the LAN console. */
const NATIVE_SHELL_ORIGINS = new Set(["capacitor://localhost", "ionic://localhost"]);

export function checkSharedWrite(request: Request): Response | null {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return Response.json({ error: "JSON required" }, { status: 415 });
  const origin = request.headers.get("origin");
  if (!origin) return null;
  if (NATIVE_SHELL_ORIGINS.has(origin)) return null;
  const url = new URL(request.url);
  const trusted = process.env.AGENT_TRUST_TUNNEL_PROXY === "1";
  const host = trusted ? request.headers.get("x-forwarded-host")?.split(",")[0].trim() || request.headers.get("host") || url.host : request.headers.get("host") || url.host;
  const protocol = trusted ? request.headers.get("x-forwarded-proto")?.split(",")[0].trim() || url.protocol.slice(0, -1) : url.protocol.slice(0, -1);
  if (origin !== `${protocol}://${host}`) return Response.json({ error: "Cross-origin write denied" }, { status: 403 });
  return null;
}
