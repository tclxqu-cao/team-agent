import { sharedCron } from "../../../lib/shared-cron";
import { businessCatalog } from "../../../lib/business-catalog";
import { checkSharedWrite } from "../../../lib/shared-write-request";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const rejected = checkSharedWrite(request); if (rejected) return rejected;
  try {
    const { method, args } = await request.json();
    if (typeof method !== "string" || !Array.isArray(args) || args.length > 10) return Response.json({ error: "Invalid operation" }, { status: 400 });
    return Response.json(method.startsWith("cron") ? sharedCron().call(method, args) : await businessCatalog().call(method, args), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Operation failed" }, { status: 400 });
  }
}
