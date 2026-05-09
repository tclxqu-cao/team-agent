import { useEffect, useState } from "react";

interface UploadEntry {
  id: string; fileName: string; filePath: string; mimeType: string;
  size: number; status: string; error?: string; created: string; updated: string;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function UploadViewer() {
  const [uploads, setUploads] = useState<UploadEntry[]>([]);

  const load = async () => {
    if (window.agentApi) { const list = await window.agentApi.listUploads(); setUploads(list); }
  };

  useEffect(() => { load(); }, []);

  const handleUpload = async () => {
    if (!window.agentApi) return;
    const filePath = await window.agentApi.openFileDialog();
    if (!filePath) return;
    const fileName = filePath.split(/[/\\]/).pop() || "unknown";
    const now = new Date().toISOString();
    await window.agentApi.saveUpload({
      id: crypto.randomUUID(), fileName, filePath, mimeType: "",
      size: 0, status: "pending", created: now, updated: now,
    });
    load();
  };

  const statusColor = (status: string) => {
    switch (status) {
      case "completed": return "var(--success)";
      case "uploading": return "var(--warning)";
      case "failed": return "var(--danger)";
      default: return "var(--text-muted)";
    }
  };

  return (
    <div style={{ padding: "40px 48px", maxWidth: 720, animation: "fadeInUp 0.4s var(--ease-out)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24 }}>
        <div>
          <h2 style={{ fontFamily: "var(--font-display)", fontSize: 28, color: "var(--text-primary)", fontWeight: 400, letterSpacing: "-0.02em" }}>
            Uploads
          </h2>
          <p style={{ color: "var(--text-muted)", fontSize: 14, marginTop: 4 }}>
            File attachments for your sessions.
          </p>
        </div>
        <button onClick={handleUpload} style={{
          padding: "10px 20px", borderRadius: "var(--radius-sm)", border: "none",
          background: "var(--accent)", color: "var(--text-inverse)",
          fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "var(--font-body)",
        }}>
          + Upload File
        </button>
      </div>

      {uploads.length === 0 && (
        <div style={{ color: "var(--text-muted)", fontSize: 14, padding: "60px 0", textAlign: "center" }}>
          No uploads yet. Click "+ Upload File" to select one.
        </div>
      )}

      {uploads.map((u) => (
        <div key={u.id} style={{
          padding: "14px 16px", marginBottom: 8, background: "var(--bg-glass)",
          borderRadius: "var(--radius-sm)", border: "1px solid var(--border-subtle)",
          backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
          transition: "border-color 0.2s",
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              {/* File icon */}
              <div style={{
                width: 36, height: 36, borderRadius: "var(--radius-sm)",
                background: "rgba(255,255,255,0.03)", display: "flex",
                alignItems: "center", justifyContent: "center",
                fontSize: 16, color: "var(--text-muted)",
              }}>
                ⇧
              </div>
              <div>
                <div style={{ color: "var(--text-primary)", fontWeight: 600, fontSize: 14 }}>
                  {u.fileName}
                </div>
                <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2, fontFamily: "var(--font-mono)" }}>
                  {u.filePath} · {formatSize(u.size)}
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <span style={{
                fontSize: 10, padding: "3px 10px", borderRadius: 10,
                background: `${statusColor(u.status)}18`, color: statusColor(u.status),
                textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600,
              }}>
                {u.status}
              </span>
              <button onClick={async () => {
                if (window.agentApi) { await window.agentApi.deleteUpload(u.id); load(); }
              }} style={{
                ...btnSmStyle, color: "var(--danger)",
              }}>
                Del
              </button>
            </div>
          </div>
          {u.error && (
            <div style={{
              fontSize: 12, color: "var(--danger)", marginTop: 8,
              padding: "6px 10px", borderRadius: 6,
              background: "rgba(248,113,113,0.08)", fontFamily: "var(--font-mono)",
            }}>
              {u.error}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

const btnSmStyle: React.CSSProperties = {
  padding: "4px 10px", borderRadius: 6, fontSize: 11,
  border: "none", background: "rgba(255,255,255,0.05)",
  color: "var(--text-secondary)", cursor: "pointer",
  fontFamily: "var(--font-body)", fontWeight: 500,
};