import { useState } from "react";

interface AskUserCardProps {
  questionId: string;
  question: string;
  options?: Array<{ label: string; description: string }>;
  multiSelect?: boolean;
  answered?: boolean;
  answer?: string;
  onAnswer: (answer: string, selectedIndices?: number[]) => void;
}

export default function AskUserCard({
  question,
  options,
  multiSelect,
  answered,
  answer,
  onAnswer,
}: AskUserCardProps) {
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
  const [freeText, setFreeText] = useState("");

  const hasOptions = options && options.length > 0;

  const toggleOption = (idx: number) => {
    if (answered) return;
    setSelectedIndices((prev) => {
      const next = new Set(prev);
      if (multiSelect) {
        if (next.has(idx)) next.delete(idx);
        else next.add(idx);
      } else {
        next.clear();
        next.add(idx);
      }
      return next;
    });
  };

  const handleSubmitOptions = () => {
    if (selectedIndices.size === 0) return;
    const labels = Array.from(selectedIndices).map((i) => options![i].label);
    onAnswer(labels.join(", "), Array.from(selectedIndices));
  };

  const handleSubmitText = () => {
    if (!freeText.trim()) return;
    onAnswer(freeText.trim());
  };

  return (
    <div style={{ marginBottom: 12 }}>
      <div
        style={{
          borderRadius: 12,
          border: "1px solid",
          borderColor: answered ? "var(--border-subtle)" : "rgba(79,110,247,0.35)",
          background: answered ? "var(--bg-deep)" : "linear-gradient(135deg, rgba(79,110,247,0.04) 0%, var(--bg-deep) 100%)",
          overflow: "hidden",
          transition: "border-color 0.2s ease",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "10px 14px",
            borderBottom: answered ? "1px solid var(--border-subtle)" : "1px solid rgba(79,110,247,0.15)",
          }}
        >
          <div
            style={{
              width: 24,
              height: 24,
              borderRadius: 6,
              background: answered ? "var(--bg-surface)" : "rgba(79,110,247,0.1)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            {answered ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2.5" strokeLinecap="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round">
                <circle cx="12" cy="12" r="10" />
                <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
            )}
          </div>
          <span
            style={{
              fontSize: 10,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              color: answered ? "var(--text-muted)" : "var(--accent)",
              flex: 1,
            }}
          >
            {answered ? "已回答" : "向你提问"}
          </span>
          {multiSelect && !answered && (
            <span
              style={{
                fontSize: 9,
                padding: "1px 6px",
                borderRadius: 10,
                background: "var(--accent-dim)",
                color: "var(--accent)",
                fontWeight: 500,
              }}
            >
              可多选
            </span>
          )}
        </div>

        {/* Question */}
        <div
          style={{
            padding: "12px 14px 8px",
            fontSize: 13,
            color: "var(--text-primary)",
            lineHeight: 1.6,
            fontWeight: 500,
          }}
        >
          {question}
        </div>

        {/* Answered state — show what was selected */}
        {answered && (
          <div
            style={{
              padding: "6px 14px 12px",
              fontSize: 12,
              color: "var(--text-secondary)",
            }}
          >
            <span style={{ fontWeight: 500 }}>回答：</span>
            {answer}
          </div>
        )}

        {/* Options */}
        {hasOptions && !answered && (
          <div style={{ padding: "4px 14px 6px", display: "flex", flexDirection: "column", gap: 6 }}>
            {options!.map((opt, idx) => {
              const isSelected = selectedIndices.has(idx);
              return (
                <button
                  key={idx}
                  onClick={() => toggleOption(idx)}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 10,
                    padding: "9px 12px",
                    borderRadius: 8,
                    border: "1px solid",
                    borderColor: isSelected ? "var(--accent)" : "var(--border-subtle)",
                    background: isSelected ? "rgba(79,110,247,0.06)" : "var(--bg-surface)",
                    cursor: "pointer",
                    textAlign: "left",
                    fontFamily: "var(--font-body)",
                    transition: "all 0.15s ease",
                    width: "100%",
                  }}
                >
                  {/* Selection indicator */}
                  <div
                    style={{
                      width: 16,
                      height: 16,
                      borderRadius: multiSelect ? 4 : 8,
                      border: `2px solid ${isSelected ? "var(--accent)" : "var(--border-subtle)"}`,
                      background: isSelected ? "var(--accent)" : "transparent",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                      marginTop: 1,
                      transition: "all 0.15s ease",
                    }}
                  >
                    {isSelected && (
                      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 12.5,
                        fontWeight: isSelected ? 600 : 500,
                        color: isSelected ? "var(--text-primary)" : "var(--text-secondary)",
                      }}
                    >
                      {opt.label}
                    </div>
                    {opt.description && (
                      <div
                        style={{
                          fontSize: 11,
                          color: "var(--text-muted)",
                          marginTop: 2,
                          lineHeight: 1.4,
                        }}
                      >
                        {opt.description}
                      </div>
                    )}
                  </div>
                </button>
              );
            })}

            {/* Submit button for options */}
            <button
              onClick={handleSubmitOptions}
              disabled={selectedIndices.size === 0}
              style={{
                marginTop: 2,
                padding: "7px 16px",
                borderRadius: 8,
                border: "none",
                background: selectedIndices.size > 0 ? "var(--accent)" : "var(--bg-surface)",
                color: selectedIndices.size > 0 ? "white" : "var(--text-muted)",
                cursor: selectedIndices.size > 0 ? "pointer" : "default",
                fontSize: 12,
                fontWeight: 600,
                fontFamily: "var(--font-body)",
                alignSelf: "flex-end",
                transition: "all 0.15s ease",
              }}
            >
              确认选择
            </button>
          </div>
        )}

        {/* Free text input — always shown when not answered */}
        {!answered && (
          <div style={{
            padding: hasOptions ? "4px 14px 12px" : "4px 14px 12px",
            display: "flex",
            gap: 8,
            borderTop: hasOptions ? "1px solid var(--border-subtle)" : "none",
            marginTop: hasOptions ? 2 : 0,
          }}>
            <input
              type="text"
              value={freeText}
              onChange={(e) => setFreeText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmitText();
                }
              }}
              placeholder={hasOptions ? "或输入自定义回答…" : "输入你的回答…"}
              style={{
                flex: 1,
                padding: "8px 12px",
                borderRadius: 8,
                border: "1px solid var(--border-subtle)",
                background: "var(--bg-surface)",
                color: "var(--text-primary)",
                fontSize: 13,
                fontFamily: "var(--font-body)",
                outline: "none",
                transition: "border-color 0.15s ease",
              }}
              onFocus={(e) => {
                e.currentTarget.style.borderColor = "var(--accent)";
              }}
              onBlur={(e) => {
                e.currentTarget.style.borderColor = "var(--border-subtle)";
              }}
            />
            <button
              onClick={handleSubmitText}
              disabled={!freeText.trim()}
              style={{
                padding: "8px 16px",
                borderRadius: 8,
                border: "none",
                background: freeText.trim() ? "var(--accent)" : "var(--bg-surface)",
                color: freeText.trim() ? "white" : "var(--text-muted)",
                cursor: freeText.trim() ? "pointer" : "default",
                fontSize: 12,
                fontWeight: 600,
                fontFamily: "var(--font-body)",
                transition: "all 0.15s ease",
              }}
            >
              发送
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
