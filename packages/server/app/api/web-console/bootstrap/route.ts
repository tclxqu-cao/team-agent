export const dynamic = "force-dynamic";

/** The custom gateway issues device-bound nonces before requests reach Next.
 * A direct Next entry must fail closed instead of reviving anonymous access. */
export async function GET() {
  return Response.json({ error: "Device pairing gateway required" }, { status: 401 });
}
