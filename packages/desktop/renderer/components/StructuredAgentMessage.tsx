import { useMemo, useState, type ReactNode } from "react";
import { Braces, Copy } from "lucide-react";
import { copyTextToClipboard } from "../lib/clipboard";
import {
  parseStructuredAgentMessage,
  suggestionLabel,
  type AgentMessageEnvelope,
  type JsonValue,
  type StructuredAgentMessage as StructuredAgentMessageModel,
} from "../lib/structured-agent-message";

const INITIAL_VISIBLE_ENTRIES = 40;
const MAX_TREE_DEPTH = 8;

export interface StructuredAgentMessageProps {
  text: string;
  complete: boolean;
  renderText: (text: string) => ReactNode;
  suggestionsEnabled: boolean;
  onSuggestionSend: (command: string) => void;
  onCopyFailed?: () => void;
}

interface StructuredAgentMessageViewProps {
  message: StructuredAgentMessageModel;
  renderText: (text: string) => ReactNode;
  suggestionsEnabled: boolean;
  onSuggestionSend: (command: string) => void;
  onCopyFailed?: () => void;
}

interface JsonValueTreeProps {
  value: JsonValue;
  label?: string;
  depth?: number;
}

function jsonContainerEntries(value: JsonValue[] | Record<string, JsonValue>): Array<[string, JsonValue]> {
  return Array.isArray(value)
    ? value.map((item, index) => [String(index), item])
    : Object.entries(value);
}

function JsonPrimitive({ value }: { value: Exclude<JsonValue, JsonValue[] | Record<string, JsonValue>> }) {
  if (value === null) return <span className="json-tree__value json-tree__value--null">null</span>;
  if (typeof value === "boolean") {
    return <span className="json-tree__value json-tree__value--boolean">{String(value)}</span>;
  }
  if (typeof value === "number") {
    return <span className="json-tree__value json-tree__value--number">{value}</span>;
  }
  return (
    <span className="json-tree__value json-tree__value--string">
      <span aria-hidden="true">&quot;</span>{value}<span aria-hidden="true">&quot;</span>
    </span>
  );
}

export function JsonValueTree({ value, label, depth = 0 }: JsonValueTreeProps) {
  const [showAll, setShowAll] = useState(false);
  if (value === null || typeof value !== "object") {
    return (
      <div className="json-tree__row">
        {label !== undefined && <span className="json-tree__key">{label}</span>}
        {label !== undefined && <span className="json-tree__separator">:</span>}
        <JsonPrimitive value={value} />
      </div>
    );
  }

  const entries = jsonContainerEntries(value);
  const containerLabel = Array.isArray(value) ? `数组 · ${entries.length} 项` : `对象 · ${entries.length} 项`;
  if (depth >= MAX_TREE_DEPTH) {
    return (
      <div className="json-tree__row json-tree__row--limit">
        {label !== undefined && <span className="json-tree__key">{label}</span>}
        <span className="json-tree__limit">{containerLabel}，已折叠至深度 {MAX_TREE_DEPTH}</span>
      </div>
    );
  }

  const visibleEntries = showAll ? entries : entries.slice(0, INITIAL_VISIBLE_ENTRIES);
  const hiddenCount = entries.length - visibleEntries.length;
  return (
    <details className="json-tree" open={depth === 0}>
      <summary className="json-tree__summary">
        {label !== undefined && <span className="json-tree__key">{label}</span>}
        <span className="json-tree__container-label">{containerLabel}</span>
      </summary>
      <div className="json-tree__children">
        {entries.length === 0 && <div className="json-tree__empty">空</div>}
        {visibleEntries.map(([key, child]) => (
          <JsonValueTree key={key} value={child} label={key} depth={depth + 1} />
        ))}
        {hiddenCount > 0 && (
          <button
            type="button"
            className="json-tree__more"
            onClick={() => setShowAll(true)}
          >
            显示其余 {hiddenCount} 项
          </button>
        )}
      </div>
    </details>
  );
}

function formattedJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function RawJsonDisclosure({ raw, onCopyFailed }: { raw: string; onCopyFailed?: () => void }) {
  const copyRaw = async () => {
    if (!await copyTextToClipboard(raw)) onCopyFailed?.();
  };
  return (
    <details className="structured-agent-message__raw">
      <summary>查看原始 JSON</summary>
      <div className="structured-agent-message__raw-toolbar">
        <button type="button" title="复制原始 JSON" aria-label="复制原始 JSON" onClick={() => { void copyRaw(); }}>
          <Copy size={14} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </div>
      <pre>{formattedJson(raw)}</pre>
    </details>
  );
}

function EnvelopeView({
  envelope,
  raw,
  renderText,
  suggestionsEnabled,
  onSuggestionSend,
  onCopyFailed,
}: {
  envelope: AgentMessageEnvelope;
  raw: string;
  renderText: (text: string) => ReactNode;
  suggestionsEnabled: boolean;
  onSuggestionSend: (command: string) => void;
  onCopyFailed?: () => void;
}) {
  return (
    <section className="structured-agent-message" data-kind="envelope">
      <header className="structured-agent-message__header">
        <h3 className="structured-agent-message__title">{envelope.title}</h3>
        {envelope.summary && <p className="structured-agent-message__summary">{envelope.summary}</p>}
      </header>

      <div className="structured-agent-message__blocks">
        {envelope.blocks.map((block, index) => block.kind === "text" ? (
          <div key={index} className="structured-agent-message__text" data-tone={block.tone ?? "body"}>
            {renderText(block.text)}
          </div>
        ) : (
          <details key={index} className="structured-agent-message__unknown-block">
            <summary>{block.blockType} 内容</summary>
            <JsonValueTree value={block.value} />
          </details>
        ))}
      </div>

      {envelope.suggestions.length > 0 && (
        <div className="structured-agent-message__suggestions" aria-label="继续提问">
          {envelope.suggestions.map((command) => (
            <button
              key={command}
              type="button"
              className="structured-agent-suggestion"
              disabled={!suggestionsEnabled}
              title={`发送 ${command}`}
              aria-label={`${suggestionLabel(command)}，发送 ${command}`}
              onClick={() => onSuggestionSend(command)}
            >
              {suggestionLabel(command)}
            </button>
          ))}
        </div>
      )}

      {envelope.sources.length > 0 && (
        <details className="structured-agent-message__details">
          <summary>参考来源 {envelope.sources.length}</summary>
          <ul>{envelope.sources.map((source) => <li key={source}>{source}</li>)}</ul>
        </details>
      )}

      <details className="structured-agent-message__details">
        <summary>消息信息</summary>
        <dl>
          <div><dt>格式版本</dt><dd>{envelope.schemaVersion}</dd></div>
          {envelope.skill && <div><dt>能力</dt><dd>{envelope.skill}</dd></div>}
          {envelope.generatedAt && <div><dt>生成时间</dt><dd>{envelope.generatedAt}</dd></div>}
        </dl>
      </details>
      <RawJsonDisclosure raw={raw} onCopyFailed={onCopyFailed} />
    </section>
  );
}

export function StructuredAgentMessageView({
  message,
  renderText,
  suggestionsEnabled,
  onSuggestionSend,
  onCopyFailed,
}: StructuredAgentMessageViewProps) {
  if (message.kind === "envelope") {
    return (
      <EnvelopeView
        envelope={message.value}
        raw={message.raw}
        renderText={renderText}
        suggestionsEnabled={suggestionsEnabled}
        onSuggestionSend={onSuggestionSend}
        onCopyFailed={onCopyFailed}
      />
    );
  }
  return (
    <section className="structured-agent-message" data-kind="json">
      <div className="structured-agent-message__data-title">
        <Braces size={15} strokeWidth={1.8} aria-hidden="true" />
        <span>结构化数据</span>
      </div>
      <JsonValueTree value={message.value} />
      <RawJsonDisclosure raw={message.raw} onCopyFailed={onCopyFailed} />
    </section>
  );
}

export default function StructuredAgentMessage({
  text,
  complete,
  renderText,
  suggestionsEnabled,
  onSuggestionSend,
  onCopyFailed,
}: StructuredAgentMessageProps) {
  const parsed = useMemo(() => parseStructuredAgentMessage(text, complete), [complete, text]);
  return parsed ? (
    <StructuredAgentMessageView
      message={parsed}
      renderText={renderText}
      suggestionsEnabled={suggestionsEnabled}
      onSuggestionSend={onSuggestionSend}
      onCopyFailed={onCopyFailed}
    />
  ) : <>{renderText(text)}</>;
}
