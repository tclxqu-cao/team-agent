import { NextResponse } from "next/server";
import { readWorkspaceChanges } from "../../../lib/workspace-changes";
import { projectErrorResponse, webProjectService } from "../projects/project-http";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const path = new URL(request.url).searchParams.get("path");
  if (!path?.trim()) return NextResponse.json({ error: "请选择工作目录" }, { status: 400 });
  try {
    const changes = await readWorkspaceChanges(path, value => webProjectService.canonicalDirectory(value));
    return NextResponse.json(changes, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const response = projectErrorResponse(error);
    return NextResponse.json({ error: response.status === 500 ? "读取 Git 变更失败，请重试" : response.body.error }, { status: response.status });
  }
}
