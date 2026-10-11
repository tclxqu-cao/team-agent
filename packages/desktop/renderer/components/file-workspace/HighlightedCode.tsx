import { useEffect, useMemo, useState } from "react";
import { codePreviewLanguage, MAX_HIGHLIGHT_CHARACTERS } from "./codePreviewLanguage";
import "./HighlightedCode.css";

type HighlightCode = typeof import("./codeSyntax").highlightCode;

export default function HighlightedCode({ path, chunks, fileSize }: { path: string; chunks: string[]; fileSize?: number }) {
  const [highlight, setHighlight] = useState<HighlightCode | null>(null);
  const language = codePreviewLanguage(path);
  const eligible = chunks.length > 0 && language !== null
    && (fileSize === undefined || fileSize <= MAX_HIGHLIGHT_CHARACTERS)
    && chunks.reduce((length, chunk) => length + chunk.length, 0) <= MAX_HIGHLIGHT_CHARACTERS;

  useEffect(() => {
    if (!eligible) return;
    let cancelled = false;
    // Load grammars only when a code file is opened. Text remains visible meanwhile.
    void import("./codeSyntax").then(({ highlightCode }) => {
      if (!cancelled) setHighlight(() => highlightCode);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [eligible]);

  const markup = useMemo(() => (
    eligible && highlight ? highlight(path, chunks.join("")) : null
  ), [chunks, eligible, highlight, path]);

  if (markup !== null) {
    return <code className="file-code-preview" data-language={language} dangerouslySetInnerHTML={{ __html: markup }} />;
  }
  return (
    <code className="file-code-preview">
      {chunks.map((chunk, index) => <span key={index}>{chunk}</span>)}
    </code>
  );
}
