import { Fragment, useEffect, useMemo, useState } from "react";
import { codePreviewLanguage, MAX_HIGHLIGHT_CHARACTERS } from "./codePreviewLanguage";
import { codePreviewLines } from "./codePreviewLines";
import "./HighlightedCode.css";

type HighlightCode = typeof import("./codeSyntax").highlightCodeLines;

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
    void import("./codeSyntax").then(({ highlightCodeLines }) => {
      if (!cancelled) setHighlight(() => highlightCodeLines);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [eligible]);

  const sourceLines = useMemo(() => codePreviewLines(chunks), [chunks]);
  const highlightedLines = useMemo(() => (
    eligible && highlight ? highlight(path, chunks.join("")) : null
  ), [chunks, eligible, highlight, path]);

  return (
    <code className="file-code-preview" data-language={language ?? undefined}>
      {sourceLines.map((line, index) => {
        const newline = index < sourceLines.length - 1 ? "\n" : "";
        return (
          <Fragment key={index}>
            <span className="file-code-line-number" aria-hidden="true" data-line-number={index + 1} />
            {highlightedLines ? (
              <span className="file-code-line-content" dangerouslySetInnerHTML={{ __html: highlightedLines[index] + newline }} />
            ) : (
              <span className="file-code-line-content">{line}{newline}</span>
            )}
          </Fragment>
        );
      })}
    </code>
  );
}
