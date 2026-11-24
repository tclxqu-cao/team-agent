import { useRef, useState } from "react";
import type { AskUserField } from "@agent/core";
import { CircleHelp, Pencil } from "lucide-react";
import "../styles/ask-user-card.css";

interface AskUserCardProps {
  questionId: string;
  question: string;
  options?: Array<{ label: string; description: string }>;
  fields?: AskUserField[];
  multiSelect?: boolean;
  cancellable?: boolean;
  allowFreeText?: boolean;
  answered?: boolean;
  cancelled?: boolean;
  answer?: string;
  onAnswer: (answer: string, selectedIndices?: number[]) => void | Promise<void>;
}

export default function AskUserCard({
  questionId,
  question,
  options,
  fields,
  multiSelect,
  cancellable,
  allowFreeText = true,
  answered,
  cancelled,
  answer,
  onAnswer,
}: AskUserCardProps) {
  const settled = answered || cancelled;
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
  const [freeText, setFreeText] = useState("");
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const submittingRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const hasFields = Boolean(fields?.length);
  const hasOptions = Boolean(options?.length);
  const hasAnswer = hasFields
    ? selectedIndices.size > 0 || Object.values(fieldValues).some((value) => value.trim())
    : selectedIndices.size > 0 || Boolean(freeText.trim());

  const submit = async (value: string, indices?: number[]) => {
    if (settled || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setSubmitError("");
    try {
      await onAnswer(value, indices);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "回答发送失败，请重试。");
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const toggleOption = (index: number) => {
    if (settled || submittingRef.current) return;
    setSelectedIndices((previous) => {
      const next = new Set(previous);
      if (multiSelect) {
        if (next.has(index)) next.delete(index);
        else next.add(index);
      } else {
        next.clear();
        next.add(index);
      }
      return next;
    });
  };

  const handleSubmit = () => {
    if (!hasAnswer) return;
    const indices = Array.from(selectedIndices).sort((left, right) => left - right);
    const selected = indices.map((index) => options![index].label);
    if (hasFields) {
      const values = Object.fromEntries(
        (fields ?? []).map((field) => [field.name, fieldValues[field.name]?.trim() ?? ""]),
      );
      if (!values.model && selected.length > 0) values.model = selected[0];
      void submit(JSON.stringify({ fields: values, selectedOptions: selected }), indices);
    } else if (freeText.trim()) {
      void submit(freeText.trim());
    } else {
      void submit(selected.join(", "), indices);
    }
  };

  if (answered && !cancelled) {
    return (
      <div className="ask-user-answer" aria-label="已回答的问题" data-question-id={questionId}>
        <div className="ask-user-answer__bubble">
          <div className="ask-user-answer__question">{question}</div>
          <div className="ask-user-answer__text">
            {hasFields ? "配置已提交（敏感字段已隐藏）" : answer}
          </div>
        </div>
      </div>
    );
  }

  return (
    <section
      className={`ask-user-card${cancelled ? " ask-user-card--cancelled" : ""}`}
      aria-label={cancelled ? "已中断的问题" : "向你提问"}
      aria-busy={submitting || undefined}
      data-question-id={questionId}
    >
      <div className="ask-user-card__header">
        <CircleHelp size={14} aria-hidden="true" />
        <span>{cancelled ? "已中断" : "问题"}</span>
        {multiSelect && !settled && <span className="ask-user-card__multi-select">可多选</span>}
      </div>
      <div className="ask-user-card__question">{question}</div>

      {cancelled ? (
        <div className="ask-user-card__cancelled">
          {options?.map((option, index) => <div key={index}>{option.label}</div>)}
          <div>提问已中断，请让助手重新提问。</div>
        </div>
      ) : (
        <>
          {hasOptions && (
            <div className="ask-user-card__options" role="group" aria-label={multiSelect ? "选择回答（可多选）" : "选择回答"}>
              {options!.map((option, index) => (
                <button
                  key={index}
                  type="button"
                  className="ask-user-card__option"
                  aria-pressed={selectedIndices.has(index)}
                  disabled={submitting}
                  onClick={() => toggleOption(index)}
                >
                  <span className="ask-user-card__option-number" aria-hidden="true">{index + 1}</span>
                  <span className="ask-user-card__option-body">
                    <span className="ask-user-card__option-label">{option.label}</span>
                    {option.description && <span className="ask-user-card__option-description">{option.description}</span>}
                  </span>
                </button>
              ))}
            </div>
          )}

          {hasFields && (
            <div className="ask-user-card__fields">
              {fields!.map((field) => (
                <label key={field.name} className="ask-user-card__field">
                  <span>{field.label}</span>
                  <input
                    type={field.type === "secret" ? "password" : "text"}
                    value={fieldValues[field.name] ?? ""}
                    onChange={(event) => setFieldValues((previous) => ({ ...previous, [field.name]: event.target.value }))}
                    placeholder={field.description}
                    autoComplete={field.type === "secret" ? "off" : undefined}
                    disabled={submitting}
                  />
                  {field.description && <span className="ask-user-card__field-description">{field.description}</span>}
                </label>
              ))}
            </div>
          )}

          {submitError && <div className="ask-user-card__error" role="alert">{submitError}</div>}
          <div className="ask-user-card__footer">
            {!hasFields && allowFreeText && (
              <label className="ask-user-card__custom-answer">
                <Pencil size={14} aria-hidden="true" />
                <input
                  type="text"
                  aria-label="自定义回答"
                  value={freeText}
                  disabled={submitting}
                  onChange={(event) => setFreeText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      handleSubmit();
                    }
                  }}
                  placeholder={hasOptions ? "或自行撰写回复" : "输入你的回答"}
                />
              </label>
            )}
            {cancellable && <button type="button" className="ask-user-card__send" disabled={submitting} onClick={() => { void submit("取消提问", [-1]); }}>取消</button>}
            <button className="ask-user-card__send" type="button" disabled={submitting || !hasAnswer} onClick={handleSubmit}>
              {submitting ? "正在发送…" : hasFields ? "确认配置" : "发送"}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
