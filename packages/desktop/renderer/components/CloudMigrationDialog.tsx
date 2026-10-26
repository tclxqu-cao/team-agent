import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { CloudUpload, FolderOpen, LoaderCircle } from "lucide-react";

/**
 * 本地会话 → agent-sandbox 云端承接会话的一键迁移对话框。
 *
 * 两步交互：dryRun 预览（将上传的文件清单/数量/大小/跳过项）→ 确认上传。
 * 服务端能力：POST /api/sessions/:id/migrate-to-cloud[?dryRun=1]。
 */

/** 桌面端经 sharedServiceApi（IPC→主进程→服务端 HTTP）调用，与 web 端 fetch 同构。 */
function postMigration(sessionId: string, dryRun: boolean): Promise<{ status: number; body: Record<string, unknown> }> {
  const path = `/api/sessions/${encodeURIComponent(sessionId)}/migrate-to-cloud${dryRun ? "?dryRun=1" : ""}`;
  const bridge = typeof window !== "undefined" ? (window as { sharedServiceApi?: { request(path: string, method: string, body?: string): Promise<{ status: number; body: string }> } }).sharedServiceApi : undefined;
  if (bridge) {
    return bridge.request(path, "POST").then((response) => ({
      status: response.status,
      body: (JSON.parse(response.body || "{}") ?? {}) as Record<string, unknown>,
    }));
  }
  if (typeof fetch === "function") {
    return fetch(path, { method: "POST" }).then(async (response) => ({
      status: response.status,
      body: (await response.json().catch(() => ({}))) as Record<string, unknown>,
    }));
  }
  return Promise.reject(new Error("当前环境无法访问服务端接口"));
}

interface MigrationPreview {
  dryRun: true;
  title: string;
  cwd: string;
  fileCount: number;
  totalBytes: number;
  files: string[];
  skipped: string[];
  historyMessages: number;
}

interface MigrationResult {
  migrated: true;
  cloudSession: { id: string; name: string; workdir: string | null };
  taskStatus: string;
  fileCount: number;
}

export default function CloudMigrationDialog({
  sessionId,
  sessionTitle,
  onClose,
}: {
  sessionId: string;
  sessionTitle: string;
  onClose(): void;
}) {
  const [preview, setPreview] = useState<MigrationPreview | null>(null);
  const [result, setResult] = useState<MigrationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setError(null);
    postMigration(sessionId, true)
      .then(({ status, body }) => {
        if (status >= 400) throw new Error(typeof body.error === "string" ? body.error : `HTTP ${status}`);
        setPreview(body as unknown as MigrationPreview);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : "预览失败");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [sessionId]);

  const upload = () => {
    setBusy(true);
    setError(null);
    postMigration(sessionId, false)
      .then(({ status, body }) => {
        if (status >= 400) throw new Error(typeof body.error === "string" ? body.error : `HTTP ${status}`);
        setResult(body as unknown as MigrationResult);
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "迁移失败");
      })
      .finally(() => setBusy(false));
  };

  return createPortal(
    <div
      className="cloud-migration-overlay"
      role="dialog"
      aria-label={`转移会话到云端：${sessionTitle}`}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) onClose();
      }}
    >
      <div className="cloud-migration-modal">
        <header>
          <CloudUpload size={18} aria-hidden="true" />
          <strong>转移到云端</strong>
          <span className="cloud-migration-subtitle">{sessionTitle}</span>
        </header>

        {busy && !preview && !result && (
          <p className="cloud-migration-status" role="status">
            <LoaderCircle size={15} className="spin" aria-hidden="true" />
            正在扫描工作目录…
          </p>
        )}

        {error && (
          <p className="cloud-migration-status cloud-migration-status--error" role="alert">
            {error}
            {!preview && !result && (
              <>
                {" "}
                <button type="button" onClick={onClose}>
                  关闭
                </button>
              </>
            )}
          </p>
        )}

        {preview && !result && (
          <div className="cloud-migration-preview">
            <p className="cloud-migration-summary">
              <FolderOpen size={14} aria-hidden="true" />
              将上传 <strong>{preview.fileCount}</strong> 个文件（
              {(preview.totalBytes / 1024).toFixed(1)} KB）到你的云端沙箱，并在云端创建承接会话继续工作。
            </p>
            <dl className="cloud-migration-facts">
              <div>
                <dt>工作目录</dt>
                <dd title={preview.cwd}>{preview.cwd}</dd>
              </div>
              <div>
                <dt>会话历史</dt>
                <dd>{preview.historyMessages > 0 ? `${preview.historyMessages} 条消息摘要` : "无消息（原生会话不带本地历史）"}</dd>
              </div>
              <div>
                <dt>文件清单</dt>
                <dd className="cloud-migration-files">
                  {preview.files.map((file) => (
                    <span key={file}>{file}</span>
                  ))}
                  {preview.fileCount > preview.files.length && <span>…共 {preview.fileCount} 个</span>}
                </dd>
              </div>
              {preview.skipped.length > 0 && (
                <div>
                  <dt>已跳过</dt>
                  <dd className="cloud-migration-files cloud-migration-files--muted">
                    {preview.skipped.map((item) => (
                      <span key={item}>{item}</span>
                    ))}
                  </dd>
                </div>
              )}
            </dl>
            <p className="cloud-migration-note">
              凭据（.env / 密钥）不会上传；node_modules、构建产物自动排除。迁移后本地会话保留不动。
            </p>
          </div>
        )}

        {result && (
          <div className="cloud-migration-result" role="status">
            <p>
              ✓ 已创建云端承接会话 <strong>{result.cloudSession.name}</strong>（任务 {result.taskStatus}）
            </p>
            <p className="cloud-migration-note">
              云端工作目录 {result.cloudSession.workdir ?? "workspace/"} · 共迁移 {result.fileCount} 个文件。
              之后在云端平台的「工作区」或 CLI 里给这个会话发消息即可继续；本地会话保留不动。
            </p>
          </div>
        )}

        <footer>
          <button type="button" className="cloud-migration-cancel" onClick={onClose} disabled={busy}>
            {result ? "关闭" : "取消"}
          </button>
          {preview && !result && (
            <button type="button" className="cloud-migration-confirm" onClick={upload} disabled={busy}>
              {busy ? "迁移中…" : "确认迁移"}
            </button>
          )}
        </footer>
      </div>
    </div>,
    document.body,
  );
}
