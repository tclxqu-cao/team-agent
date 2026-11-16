import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { ReasoningSummarySection } from "@agent/core";
import { Brain, ChevronRight, LoaderCircle } from "lucide-react";
import ElapsedTime from "./ElapsedTime";

interface ReasoningSummaryProps {
  sections: ReasoningSummarySection[];
  streaming?: boolean;
  startedAt?: number;
  renderContent: (text: string) => ReactNode;
  variant?: "disclosure" | "inline";
}

export default function ReasoningSummary({ sections, streaming = false, startedAt, renderContent, variant = "disclosure" }: ReasoningSummaryProps) {
  const text = useMemo(() => [...sections]
    .sort((left, right) => left.sectionIndex - right.sectionIndex)
    .map((section) => section.text.trim())
    .filter(Boolean)
    .join("\n\n"), [sections]);
  const preview = useMemo(() => {
    if (variant === "inline") return "";
    const firstLine = text.split("\n").find((line) => line.trim()) ?? "";
    return firstLine
      .replace(/^#{1,6}\s+/, "")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/`([^`]+)`/g, "$1");
  }, [text, variant]);
  const [expanded, setExpanded] = useState(streaming);

  useEffect(() => {
    setExpanded(streaming);
  }, [streaming]);

  const content = useMemo(
    () => text && (variant === "inline" || expanded) ? renderContent(text) : null,
    [expanded, renderContent, text, variant],
  );

  if (!text) return null;
  if (variant === "inline") {
    return <div className="reasoning-summary reasoning-summary--inline">
      <div className="reasoning-summary__content">{content}</div>
    </div>;
  }
  const label = streaming ? "思考中" : "思考";
  return (
    <div className="reasoning-summary">
      <button
        type="button"
        className="reasoning-summary__toggle"
        aria-expanded={expanded}
        aria-label={`${label}，${expanded ? "收起" : "展开"}`}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="reasoning-summary__brain" aria-hidden="true">
          <Brain size={17} strokeWidth={1.8} />
        </span>
        <span className="reasoning-summary__label">
          {label}
          {streaming && startedAt !== undefined && <ElapsedTime startedAt={startedAt} />}
        </span>
        {!expanded && <span className="reasoning-summary__preview">{preview}</span>}
        <span className="reasoning-summary__spacer" />
        {streaming && <LoaderCircle className="reasoning-summary__spinner" size={13} strokeWidth={2} aria-hidden="true" />}
        <ChevronRight className="reasoning-summary__chevron" size={13} strokeWidth={2} aria-hidden="true" />
      </button>
      {expanded && <div className="reasoning-summary__content">{content}</div>}
    </div>
  );
}
