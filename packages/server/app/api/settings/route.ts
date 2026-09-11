import { sharedSettings, SettingsValidationError } from "../../../lib/shared-settings";
import { checkSharedWrite } from "../../../lib/shared-write-request";

export const dynamic = "force-dynamic";
export async function GET() {
  return Response.json(sharedSettings().publicView(), { headers: { "cache-control": "no-store" } });
}
export async function POST(request: Request) {
  const rejected = checkSharedWrite(request); if (rejected) return rejected;
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new SettingsValidationError("设置必须是对象");
    return Response.json(sharedSettings().save(body), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "保存失败" }, { status: error instanceof SettingsValidationError ? error.status : 400 });
  }
}
