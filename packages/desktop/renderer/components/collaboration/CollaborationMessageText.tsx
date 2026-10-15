import { useEffect, useId, useRef, useState } from "react";
import { postWebArtifactOpen, resolveWebArtifactPath } from "../../lib/artifact-links";
import { parseRichInlineTokens, type RichInlineToken } from "../../lib/markdown-links";

const PREVIEW_LINES = 8;

/** Retain the group's relative Markdown links while sharing chat's bare-path recognition. */
function messageTokens(text: string, cwd: string): RichInlineToken[] {
  return text.split(/(\[[^\]\n]+\]\([^\n)]+\))/g).flatMap(part => {
    const tokens = parseRichInlineTokens(part);
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    if (!link || tokens.some(token => token.type === "artifact" || token.type === "link")) return tokens;
    const target = link[2].trim().replace(/^<|>$/g, "");
    if (/^[A-Za-z][\w+.-]*:/.test(target) && !/^[A-Za-z]:[\\/]/.test(target)) return tokens;
    const path = resolveWebArtifactPath(target, cwd);
    return path ? [{ type: "artifact", label: link[1], path, raw: part }] : tokens;
  });
}

export default function CollaborationMessageText({ text, cwd }: { text: string; cwd: string }) {
  const id = useId();
  const content = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const element = content.current;
    if (!element) return;
    const measure = () => {
      const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
      setOverflowing(element.scrollHeight > lineHeight * PREVIEW_LINES + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text]);

  return <>
    <div id={id} ref={content} className="collab-message-text" data-collapsed={!expanded}>
      {messageTokens(text, cwd).map((token, index) => {
        if (token.type === "text") return token.value;
        if (token.type === "code") return <code key={index}>{token.value}</code>;
        if (token.type === "link") return <a key={index} href={token.href} target="_blank" rel="noopener noreferrer">{token.label}</a>;
        const path = resolveWebArtifactPath(token.path, cwd);
        if (!path) return token.raw;
        return <button key={index} type="button" className="collab-message-path" title={token.line ? `${path}:${token.line}` : path} aria-label={`查看文件：${token.label}`} onClick={() => {
          if (!postWebArtifactOpen(path)) void window.agentApi.openExternal(/^https?:\/\//i.test(path) ? path : `file://${path}`);
        }}>{token.label}</button>;
      })}
    </div>
    {overflowing && <button type="button" className="collab-message-toggle" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(value => !value)}>{expanded ? "收起" : "展开全文"}</button>}
  </>;
}
