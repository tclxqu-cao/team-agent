import { useState, type ReactNode } from "react";
import { requestArtifactFileContextMenu } from "../lib/artifact-file-context-menu";

export default function MessageArtifactLink({ path, label, title, onOpen, children }: {
  path: string;
  label: string;
  title?: string;
  onOpen(path: string): void;
  children: ReactNode;
}) {
  const [error, setError] = useState("");
  return <>
    <button
      type="button"
      className="chat-message-artifact-link"
      title={title ?? path}
      aria-label={`打开交付物 ${label}`}
      onClick={() => onOpen(path)}
      onContextMenu={(event) => {
        setError("");
        const pending = requestArtifactFileContextMenu(event, path, window.agentApi?.showFileContextMenu);
        void pending?.catch((cause) => {
          setError(cause instanceof Error ? cause.message : "无法定位文件，请确认文件仍然存在。");
        });
      }}
    >{children}</button>
    {error && <span role="alert" style={{ color: "var(--danger)", fontSize: 12, marginLeft: 8 }}>{error}</span>}
  </>;
}
