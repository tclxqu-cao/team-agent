import type { ReactNode } from "react";
import { requestArtifactFileContextMenu } from "../lib/artifact-file-context-menu";
import { MessageLinkActions, useMessageLinkActions } from "./MessageLinkActions";

export default function MessageArtifactLink({ path, label, line, onOpen, children }: {
  path: string;
  label: string;
  line?: number;
  onOpen(path: string): void;
  children: ReactNode;
}) {
  const actions = useMessageLinkActions<HTMLButtonElement>();
  const location = line ? `${path}:${line}` : path;
  const displayedText = () => actions.trigger.current?.textContent || label;

  return <>
    <button
      ref={actions.trigger}
      type="button"
      className="chat-message-artifact-link"
      title={location}
      aria-label={`打开交付物 ${label}`}
      {...actions.handlers}
      onClick={(event) => { if (!actions.consumeClick(event)) onOpen(path); }}
      onContextMenu={(event) => actions.handlers.onContextMenu(event, () => {
        const pending = requestArtifactFileContextMenu(event, path, window.agentApi?.showFileContextMenu, { label: displayedText(), line });
        void pending?.catch(actions.show);
        return Boolean(pending);
      })}
    >{children}</button>
    {actions.open && <MessageLinkActions title="文件链接" fieldLabel="文件路径"
      primary={{ label: "复制路径", value: location }}
      secondary={displayedText() === location ? undefined : { label: "复制链接文字", value: displayedText() }}
      onClose={actions.close} />}
  </>;
}
