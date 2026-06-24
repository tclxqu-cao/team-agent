import { useState } from "react";

interface Shot {
  index: number;
  description: string;
  prompt: string;
  duration: number;
  previewImageUrl?: string;
  videoUrl?: string;
  status: "pending" | "image_generating" | "video_generating" | "done" | "error";
  error?: string;
}

interface StoryboardWorkbenchProps {
  widgetId?: string;
  title?: string;
  shots?: Shot[];
  status?: string;
  composedVideoUrl?: string;
}

const statusIcon: Record<string, string> = {
  pending: "⏳",
  image_generating: "🎨",
  video_generating: "🎬",
  done: "✅",
  error: "❌",
};

export function StoryboardWorkbench(props: StoryboardWorkbenchProps) {
  const { title = "视频工作台", shots = [], status = "generating", composedVideoUrl } = props;
  const [collapsed, setCollapsed] = useState(false);
  const [activeVideo, setActiveVideo] = useState<string | null>(null);

  return (
    <div style={{
      border: "1px solid var(--border-subtle)",
      borderRadius: "var(--radius-md)",
      background: "var(--bg-surface)",
      overflow: "hidden",
      maxWidth: 600,
    }}>
      {/* Header */}
      <div
        onClick={() => setCollapsed(!collapsed)}
        style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "10px 16px",
          background: "var(--bg-deep)",
          cursor: "pointer", userSelect: "none",
          borderBottom: collapsed ? "none" : "1px solid var(--border-subtle)",
        }}
      >
        <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>
          🎬 {title}
        </span>
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
          {shots.filter(s => s.status === "done").length}/{shots.length} 完成
          <span style={{ marginLeft: 6, transform: collapsed ? "rotate(-90deg)" : "none", display: "inline-block", transition: "transform 0.2s" }}>▼</span>
        </span>
      </div>

      {!collapsed && (
        <div style={{ padding: "12px 16px" }}>
          {/* Shot table */}
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13, marginBottom: 12 }}>
            <thead>
              <tr style={{ background: "var(--bg-deep)" }}>
                <th style={thStyle}>#</th>
                <th style={{ ...thStyle, textAlign: "left", minWidth: 120 }}>画面描述</th>
                <th style={thStyle}>时长</th>
                <th style={thStyle}>状态</th>
                <th style={thStyle}>预览</th>
              </tr>
            </thead>
            <tbody>
              {shots.map((shot) => (
                <tr key={shot.index} style={{ borderBottom: "1px solid var(--border-subtle)" }}>
                  <td style={tdStyle}>{shot.index}</td>
                  <td style={{ ...tdStyle, textAlign: "left", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={shot.description}>
                    {shot.description}
                  </td>
                  <td style={tdStyle}>{shot.duration}s</td>
                  <td style={tdStyle}>
                    {statusIcon[shot.status] ?? "⏳"}
                    {shot.error && <span style={{ color: "var(--danger)", fontSize: 11, marginLeft: 4 }} title={shot.error}>!</span>}
                  </td>
                  <td style={tdStyle}>
                    {shot.videoUrl ? (
                      <button
                        onClick={() => setActiveVideo(shot.videoUrl!)}
                        style={{
                          background: "var(--accent-dim)", color: "var(--accent)",
                          border: "1px solid rgba(79,110,247,0.22)", borderRadius: 6,
                          padding: "2px 8px", fontSize: 11, cursor: "pointer",
                        }}
                      >▶ 播放</button>
                    ) : shot.previewImageUrl ? (
                      <img src={shot.previewImageUrl} alt={`shot-${shot.index}`} style={{ width: 48, height: 32, objectFit: "cover", borderRadius: 4, border: "1px solid var(--border-subtle)" }} />
                    ) : (
                      <span style={{ color: "var(--text-muted)", fontSize: 11 }}>—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Video player */}
          {activeVideo && (
            <video
              src={activeVideo}
              controls
              autoPlay
              style={{ width: "100%", borderRadius: 8, marginBottom: 12, border: "1px solid var(--border-subtle)" }}
            />
          )}

          {/* Composed video */}
          {composedVideoUrl && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)", marginBottom: 6 }}>完整视频</div>
              <video
                src={composedVideoUrl}
                controls
                style={{ width: "100%", borderRadius: 8, border: "1px solid var(--border-subtle)" }}
              />
            </div>
          )}

          {/* Status bar */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-muted)" }}>
            {status === "generating" && <span>🔄 生成中...</span>}
            {status === "preview_ready" && <span>📷 预览图已就绪</span>}
            {status === "video_ready" && <span>🎬 视频片段已就绪</span>}
            {status === "composed" && <span>✅ 合成完成</span>}
          </div>
        </div>
      )}
    </div>
  );
}

const thStyle: React.CSSProperties = {
  padding: "6px 10px",
  textAlign: "center",
  fontWeight: 600,
  fontSize: 12,
  color: "var(--text-muted)",
  borderBottom: "1px solid var(--border-subtle)",
};

const tdStyle: React.CSSProperties = {
  padding: "6px 10px",
  textAlign: "center",
  fontSize: 13,
  color: "var(--text-secondary)",
};
