import type { ReactNode } from "react";
import { isPlainWebLinkClick, requestTaskPaneWebLink } from "../lib/task-pane-web-links";
import { MessageLinkActions, useMessageLinkActions } from "./MessageLinkActions";

/** Empty desktop panes may claim navigation; a held link offers its address for copying. */
export default function MessageLink({ href, children, code = false }: { href: string; children: ReactNode; code?: boolean }) {
  const actions = useMessageLinkActions<HTMLAnchorElement>();
  return <>
    <a ref={actions.trigger} className={`chat-message-link${code ? " chat-message-link--code" : ""}`} href={href} target="_blank"
      rel="noopener noreferrer" title="右键或长按复制地址" {...actions.handlers}
      onContextMenu={(event) => actions.handlers.onContextMenu(event)}
      onClick={(event) => {
        if (actions.consumeClick(event)) return;
        if (isPlainWebLinkClick(event) && requestTaskPaneWebLink(href)) event.preventDefault();
      }}
    >{children}</a>
    {actions.open && <MessageLinkActions title="链接地址" fieldLabel="原始链接地址"
      primary={{ label: "复制地址", value: href }} onClose={actions.close} />}
  </>;
}
