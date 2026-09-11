/** Browser writes must originate from this console; desktop requests are
 * authenticated by the outer gateway and do not carry a browser Origin. */
export function checkSharedWrite(request: Request): Response | null {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return Response.json({ error: "JSON required" }, { status: 415 });
  const origin = request.headers.get("origin");
  if (!origin) return null;
  const url = new URL(request.url);
  const trusted = process.env.AGENT_TRUST_TUNNEL_PROXY === "1";
  const host = trusted ? request.headers.get("x-forwarded-host")?.split(",")[0].trim() || request.headers.get("host") || url.host : request.headers.get("host") || url.host;
  const protocol = trusted ? request.headers.get("x-forwarded-proto")?.split(",")[0].trim() || url.protocol.slice(0, -1) : url.protocol.slice(0, -1);
  if (origin !== `${protocol}://${host}`) return Response.json({ error: "Cross-origin write denied" }, { status: 403 });
  return null;
}
