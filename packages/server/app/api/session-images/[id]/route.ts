import { getSessionImageStore } from "../../../../lib/session-images";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: { id: string } }): Promise<Response> {
  const variant = new URL(request.url).searchParams.get("variant") ?? "preview";
  if (!/^[a-f0-9]{64}$/.test(params.id) || (variant !== "preview" && variant !== "original")) {
    return Response.json({ error: "Invalid image request" }, { status: 400 });
  }
  try {
    const dataUrl = await getSessionImageStore().read(params.id, variant);
    return Response.json({ dataUrl }, { headers: { "Cache-Control": "private, max-age=86400" } });
  } catch {
    return Response.json({ error: variant === "original" ? "原图加载失败，请重试或刷新会话" : "预览图加载失败" }, {
      status: 404, headers: { "Cache-Control": "no-store" },
    });
  }
}
