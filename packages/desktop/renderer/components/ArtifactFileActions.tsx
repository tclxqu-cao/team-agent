import { useState } from "react";
import { Download, ExternalLink, FolderOpen } from "lucide-react";
import { supportsArtifactBrowserPreview } from "../../shared/artifact-preview-types";
import type { FileWorkspacePreviewTicket } from "../../../core/src/domain/file-workspace/entities";
import { postWebArtifactOpen } from "../../../shared/src/browser/artifact-links";
import { isWebShell } from "../web/webLayout";
import "../styles/artifact-file-actions.css";

async function openWebArtifact(path: string, preview: boolean): Promise<void> {
  // Reserve the tab while the click still has user activation.
  const tab = preview ? window.open("about:blank", "_blank") : null;
  if (preview && !tab) throw new Error("浏览器阻止了新标签页，请允许后重试");
  if (tab) tab.opener = null;
  try {
    const ticket = await window.agentApi.fileWorkspaceRequest<FileWorkspacePreviewTicket>("fs:preview-open", { path });
    const url = new URL(ticket.url, window.location.href);
    if (!/^https?:$/.test(url.protocol) || !/^[\w-]+$/.test(ticket.ticketId)
      || url.pathname !== `/api/web-console/file-preview/${ticket.ticketId}`) {
      throw new Error("文件预览地址无效");
    }
    const fileName = ticket.fileName || path.split(/[\\/]/).at(-1) || "";
    if (tab && !tab.closed && supportsArtifactBrowserPreview(fileName)) {
      url.pathname += `/${encodeURIComponent(fileName)}`;
      tab.location.replace(url.href);
      return;
    }
    if (tab?.closed) return;
    tab?.close();
    url.searchParams.set("download", "1");
    const link = document.createElement("a");
    link.href = url.href;
    link.download = fileName;
    document.body.append(link);
    link.click();
    link.remove();
  } catch (error) {
    tab?.close();
    throw error;
  }
}

export default function ArtifactFileActions({ path, label }: { path: string; label: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const desktop = typeof window !== "undefined" && window.agentApi?.artifactFileAction;
  const web = isWebShell() && window.parent !== window;
  if ((!desktop && !web) || !/^(?:\/|~\/|[A-Za-z]:[\\/]|\\\\)/.test(path) || /[\0\r\n]/.test(path)) return null;

  const preview = supportsArtifactBrowserPreview(path)
    && !(web && /\.pdf$/i.test(path) && navigator.pdfViewerEnabled === false);
  const revealLabel = desktop ? "在文件管理器中显示" : "在文件树中定位";
  const openLabel = desktop ? "打开方式…" : preview ? "在浏览器中预览" : "下载文件";
  const OpenIcon = !preview && !desktop ? Download : ExternalLink;

  const run = async (action: "reveal" | "open") => {
    setError(null);
    setPending(true);
    try {
      if (desktop) {
        await desktop(path, action === "reveal" ? "reveal" : "open-with");
      } else if (action === "reveal") {
        postWebArtifactOpen(path, window, true);
      } else {
        await openWebArtifact(path, preview);
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : "文件操作失败，请重试");
    } finally {
      setPending(false);
    }
  };

  return <span className="artifact-file-actions" role="group" aria-label={`交付物操作 ${label}`}>
    <button type="button" aria-label={revealLabel} title={revealLabel} disabled={pending} onClick={() => { void run("reveal"); }}>
      <FolderOpen size={15} aria-hidden="true" />
    </button>
    <button type="button" aria-label={openLabel} title={openLabel} aria-haspopup={desktop ? "dialog" : undefined} disabled={pending} onClick={() => { void run("open"); }}>
      <OpenIcon size={15} aria-hidden="true" />
    </button>
    {error && <span role="status">{error}</span>}
  </span>;
}
