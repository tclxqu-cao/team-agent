import { isAbsolute } from "node:path";
import { NextResponse } from "next/server";
import { decodeUnifiedSessionId } from "@agent/native-runtime";
import { getNativeRuntimeService, runtimeErrorStatus } from "../../../../lib/native-runtime-service";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const cwd = params.get("cwd") ?? "";
  const fileQuery = params.get("fileQuery") ?? undefined;
  if (cwd.length > 4096 || (cwd && (!isAbsolute(cwd) || cwd.includes("\0"))) || (fileQuery?.length ?? 0) > 120) {
    return NextResponse.json({ error: "无效的工作目录或文件搜索词" }, { status: 400 });
  }
  try {
    return NextResponse.json(await getNativeRuntimeService().getCodexComposerCatalog(cwd, fileQuery));
  } catch (error) {
    return NextResponse.json({ error: "无法载入 Codex 输入选项" }, { status: runtimeErrorStatus(error) });
  }
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { sessionId?: unknown; turnId?: unknown } | null;
  if (typeof body?.sessionId !== "string" || body.sessionId.length > 256
    || typeof body.turnId !== "string" || !body.turnId.trim() || body.turnId.length > 128) {
    return NextResponse.json({ error: "无效的会话或轮次" }, { status: 400 });
  }
  try {
    if (decodeUnifiedSessionId(body.sessionId).agentType !== "codex") return NextResponse.json({ text: null });
    const text = await getNativeRuntimeService().requestComposerPrediction(body.sessionId, body.turnId);
    return NextResponse.json({ text });
  } catch (error) {
    return NextResponse.json({ error: "无法生成后续建议" }, { status: runtimeErrorStatus(error) });
  }
}
