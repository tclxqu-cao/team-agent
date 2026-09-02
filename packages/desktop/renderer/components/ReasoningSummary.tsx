import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { ReasoningSummarySection } from "@agent/core";

interface ReasoningSummaryProps {
  sections: ReasoningSummarySection[];
  streaming?: boolean;
  renderContent: (text: string) => ReactNode;
}

export default function ReasoningSummary({ sections, streaming = false, renderContent }: ReasoningSummaryProps) {
  const text = useMemo(() => [...sections]
    .sort((left, right) => left.sectionIndex - right.sectionIndex)
    .map((section) => section.text.trim())
    .filter(Boolean)
    .join("\n\n"), [sections]);
  const [expanded, setExpanded] = useState(streaming);

  useEffect(() => {
    setExpanded(streaming);
  }, [streaming]);

  if (!text) return null;
  return (
    <div className="reasoning-summary">
      <button
        type="button"
        className="reasoning-summary__toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M9 18l6-6-6-6" />
        </svg>
        <span>思考摘要</span>
        {streaming && <span className="reasoning-summary__live">生成中</span>}
      </button>
      {expanded && <div className="reasoning-summary__content">{renderContent(text)}</div>}
    </div>
  );
}
