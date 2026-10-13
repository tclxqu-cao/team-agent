"use client";

import { useEffect, useState } from "react";
import { ExternalLink, Globe } from "lucide-react";
import FlowStudioLoading from "./FlowStudioLoading";
import type { ComputerPage } from "./ComputerPageDialog";

export function knownPageFrameRestriction(url: string): boolean {
  const host = new URL(url).hostname;
  return host === "qoder.com" || host.endsWith(".qoder.com");
}

export default function ComputerPagePane({ page, reloadKey }: { page: ComputerPage; reloadKey: number }) {
  const [loading, setLoading] = useState(true);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setLoading(true); setSlow(false);
    const timer = window.setTimeout(() => setSlow(true), 12_000);
    return () => window.clearTimeout(timer);
  }, [page.id, page.url, reloadKey]);
  if (knownPageFrameRestriction(page.url)) return <main className="computer-page-blocked">
    <Globe size={36} strokeWidth={1.5} aria-hidden="true" /><h2>{page.name} 不允许内嵌</h2><p>这个网站限制了当前页面打开。可以在新页面使用，也可以在电脑菜单中修改打开方式。</p>
    <a href={page.url} target="_blank" rel="noopener noreferrer"><ExternalLink size={16} aria-hidden="true" />打开新页面</a>
  </main>;
  return <main className="computer-page-pane" aria-label={page.name} aria-busy={loading}>
    <iframe key={`${page.id}:${reloadKey}`} title={page.name} src={page.url} referrerPolicy="no-referrer" allow="clipboard-read; clipboard-write; microphone; camera" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals" onLoad={() => setLoading(false)} onError={() => { setLoading(false); setSlow(true); }} style={{ visibility: loading ? "hidden" : "visible" }} />
    {loading && <FlowStudioLoading label="REMOTE PAGE" title={`正在打开 ${page.name}`} caption="正在连接页面" icon={<Globe size={36} strokeWidth={1.5} />} />}
    {slow && <a className="computer-page-fallback" href={page.url} target="_blank" rel="noopener noreferrer">打开原页面</a>}
  </main>;
}
