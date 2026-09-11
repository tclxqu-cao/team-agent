import { useEffect, useState } from "react";
import { renderMermaid } from "../lib/mermaid-renderer";
import "./MermaidBlock.css";
import MermaidDiagram from "./MermaidDiagram";

interface MermaidBlockProps {
  code: string;
  complete: boolean;
}

export default function MermaidBlock({ code, complete }: MermaidBlockProps) {
  const [showSource, setShowSource] = useState(false);
  const [result, setResult] = useState<{ code: string; svg?: string; error?: string } | null>(null);
  const current = complete && result?.code === code ? result : null;

  useEffect(() => {
    if (!complete || !code.trim()) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void renderMermaid(code).then(
        (svg) => { if (!cancelled) setResult({ code, svg }); },
        () => { if (!cancelled) setResult({ code, error: "图表暂时无法渲染，请查看源码。" }); },
      );
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [code, complete]);

  const status = !complete ? "图表生成中…" : !code.trim() ? "暂无图表内容" : current?.error ?? (!current?.svg ? "正在渲染图表…" : null);

  return (
    <div className="mermaid-block">
      <div className="mermaid-block-header">
        <span>Mermaid</span>
        <button type="button" aria-pressed={showSource} onClick={() => setShowSource(!showSource)}>
          {showSource ? "图表" : "源码"}
        </button>
      </div>
      {status && <div className="mermaid-block-status" role="status">{status}</div>}
      {showSource || !current?.svg ? (
        <pre className="mermaid-block-source"><code>{code}</code></pre>
      ) : (
        <MermaidDiagram key={code} code={code} svg={current.svg} />
      )}
    </div>
  );
}
