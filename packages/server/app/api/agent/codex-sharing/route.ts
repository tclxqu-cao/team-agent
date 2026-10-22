import { NextResponse } from "next/server";
import { combineSharingStatus, readCodexSharing, switchCodexSharing, prepareCodexSharing } from "../../../../lib/codex-sharing-service";
import { getNativeRuntimeService } from "../../../../lib/native-runtime-service";

export const dynamic = "force-dynamic";
const respond = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
async function inspect(repair = false, prepared?: Awaited<ReturnType<typeof prepareCodexSharing>>) {
  try {
    const [desktop, health] = await Promise.all([prepared ?? readCodexSharing(repair), getNativeRuntimeService().health()]);
    const runtime = health.find(item => item.agentType === "codex");
    return respond(combineSharingStatus(desktop, runtime?.connectionMode ?? null, runtime?.connectionEndpoint));
  } catch {
    return respond({ error: { message: "无法检查或修复共享后台，请确认本机 AgentRoam 管理工具可用后重试。" } }, 503);
  }
}
export async function GET() { return inspect(); }
export async function POST(request: Request) {
  // Device authentication is enforced by the gateway. Also reject foreign browser origins.
  const origin = request.headers.get("origin");
  const protocol = process.env.AGENT_TRUST_TUNNEL_PROXY === "1" && request.headers.get("x-forwarded-proto") === "https"
    ? "https:" : new URL(request.url).protocol;
  if (origin && origin !== new URL(request.url).origin && origin !== `${protocol}//${request.headers.get("host")}`) {
    return respond({ error: { message: "不允许跨站修复共享连接。" } }, 403);
  }
  if (request.headers.get("content-type")?.includes("application/json")) {
    let body;
    try { body = await request.json(); } catch { return respond({ error: { message: "共享操作参数无效。" } }, 400); }
    if (!["share", "prepare"].includes(body?.action) || (body.action === "share" && typeof body.restartConfirmed !== "boolean")) {
      return respond({ error: { message: "共享操作参数无效。" } }, 400);
    }
    try {
      if (body.action === "prepare") return inspect(false, await prepareCodexSharing());
      await switchCodexSharing(body.restartConfirmed);
      return inspect();
    } catch (error) {
      return respond({ error: { message: error instanceof Error ? error.message : "共享切换失败，请刷新重试。" } }, 409);
    }
  }
  return inspect(true);
}
