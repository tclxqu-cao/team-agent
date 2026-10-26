import { NextResponse } from "next/server";
import { agentHost } from "../../../agent-host";
import {
  getNativeRuntimeService,
  isNativeSessionId,
} from "../../../../../lib/native-runtime-service";
import {
  collectMigrationBundle,
  readCloudSandboxConfig,
  renderSessionHistory,
  uploadMigrationBundle,
} from "../../../../../lib/cloud-migration";

/**
 * 本地会话 → 云端承接会话的一键迁移入口。
 *
 * POST /api/sessions/:id/migrate-to-cloud
 *   ?dryRun=1 只打包预览不上传（前端弹窗第一步用）；
 *   body 可带 { baseUrl, deviceToken }（显式配置优先于 env）。
 *
 * 流程：定位会话 cwd → 白名单打包 → 渲染历史 → 上传 agent-sandbox 创建承接会话。
 */
async function resolveSession(id: string): Promise<{
  title: string;
  cwd: string | null;
  messages: Array<{ role: string; content: string }>;
}> {
  if (isNativeSessionId(id)) {
    const service = getNativeRuntimeService();
    const sessions = await service.list();
    const summary = sessions.find((session) => session.id === id);
    if (!summary) throw new Error("native session not found");
    return {
      title: summary.title || summary.nativeSessionId,
      cwd: summary.cwd,
      messages: [],
    };
  }
  const store = agentHost.getSessionStore();
  const session = await store.get(id);
  if (!session) throw new Error("session not found");
  const messages = (session.messages ?? []).map((message: { role?: string; content?: unknown }) => ({
    role: message.role ?? "user",
    content: typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? ""),
  }));
  // CA 会话优先 metadata.cwd，回落项目工作目录（agent-host 的权威解析）
  let cwd = typeof session.metadata?.cwd === "string" ? (session.metadata.cwd as string) : null;
  if (!cwd) {
    try {
      cwd = await agentHost.resolveProjectWorkingDirectory(session.projectId);
    } catch {
      cwd = null;
    }
  }
  return {
    title: session.title || session.id,
    cwd,
    messages,
  };
}

async function fetchSandboxId(config: { baseUrl: string; deviceToken: string }): Promise<string> {
  const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/api/sandboxes/me`, {
    headers: { authorization: `Bearer ${config.deviceToken}` },
  });
  if (!response.ok) {
    throw new Error(`获取云端个人沙箱失败: HTTP ${response.status}`);
  }
  const sandbox = (await response.json()) as { id?: string };
  if (!sandbox.id) throw new Error("云端返回的沙箱缺少 id");
  return sandbox.id;
}

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";
  let body: Record<string, unknown> = {};
  const text = await request.text();
  if (text.trim().length > 0) {
    body = (await request.json()) as Record<string, unknown>;
  }

  let session: Awaited<ReturnType<typeof resolveSession>>;
  try {
    session = await resolveSession(params.id);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "session not found" },
      { status: 404 },
    );
  }

  if (!session.cwd) {
    return NextResponse.json(
      { error: "该会话没有关联的工作目录，无法迁移代码" },
      { status: 400 },
    );
  }

  const bundle = await collectMigrationBundle(session.cwd);
  if (bundle.files.length === 0) {
    return NextResponse.json(
      { error: "工作目录内没有可迁移的文本文件（白名单外类型全部被跳过）" },
      { status: 400 },
    );
  }

  if (dryRun) {
    return NextResponse.json({
      dryRun: true,
      title: session.title,
      cwd: session.cwd,
      fileCount: bundle.files.length,
      totalBytes: bundle.totalBytes,
      files: bundle.files.map((file) => file.path).slice(0, 50),
      skipped: bundle.skipped.slice(0, 20),
      historyMessages: session.messages.length,
    });
  }

  const config =
    typeof body.baseUrl === "string" && typeof body.deviceToken === "string"
      ? { baseUrl: body.baseUrl, deviceToken: body.deviceToken }
      : readCloudSandboxConfig();
  if (!config) {
    return NextResponse.json(
      {
        error:
          "未配置云端沙箱连接：需要 AGENT_SANDBOX_URL 与 AGENT_SANDBOX_DEVICE_TOKEN（或在请求体传 baseUrl/deviceToken）",
      },
      { status: 400 },
    );
  }

  try {
    const sandboxId = await fetchSandboxId(config);
    const history = renderSessionHistory(session.messages, {
      title: session.title,
      maxMessages: 40,
    });
    const result = await uploadMigrationBundle({
      ...config,
      sandboxId,
      name: session.title,
      files: bundle.files,
      history,
    });
    return NextResponse.json({
      migrated: true,
      cloudSession: result.session,
      taskStatus: result.task.status,
      fileCount: bundle.files.length,
      totalBytes: bundle.totalBytes,
      skipped: bundle.skipped.slice(0, 20),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "迁移失败" },
      { status: 502 },
    );
  }
}
