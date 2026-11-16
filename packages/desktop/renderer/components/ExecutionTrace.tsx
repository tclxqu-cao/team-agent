import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import type { NativeSubagentActivity, RuntimeProgress, SessionToolResultRef } from "@agent/core";
import { ChevronRight } from "lucide-react";
import type { ChatMessage } from "../stores/agentStore";
import { executionActivityRows, latestExecutionSummary } from "../lib/execution-activity-blocks";
import { toolRuntimeProgress } from "../lib/native-runtime-progress";
import { formatSessionWorkDuration } from "../lib/session-execution-summary";
import { ToolCallActivity, type ToolCallGroupItem } from "./ToolCallCard";

export function useExecutionTraceDisclosure(scope: string, isRunning: boolean) {
  const [expanded, setExpanded] = useState(isRunning);
  // Completion closes once; message refreshes preserve manual reopening.
  useEffect(() => {
    setExpanded(isRunning);
  }, [isRunning, scope]);
  return { expanded, setExpanded };
}

interface ExecutionTraceProps {
  messageId?: string;
  turnId?: string;
  isRunning: boolean;
  durationMs?: number;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}

export default function ExecutionTrace({
  messageId, turnId, isRunning, durationMs, expanded, onToggle, children,
}: ExecutionTraceProps) {
  const contentId = useId();
  return (
    <div
      className={`execution-trace${isRunning ? "" : " execution-trace--completed"}`}
      data-message-id={messageId}
      data-turn-id={turnId}
    >
      {!isRunning && (
        <button
          type="button"
          className="execution-trace__summary"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={onToggle}
        >
          <span>{formatSessionWorkDuration(durationMs)}</span>
          <ChevronRight className="execution-trace__chevron" size={14} aria-hidden="true" />
        </button>
      )}
      {expanded && <div id={contentId}>{children}</div>}
    </div>
  );
}

interface ExecutionTraceContentProps {
  messages: ChatMessage[];
  active?: boolean;
  renderContent: (text: string) => ReactNode;
  runtimeProgress: RuntimeProgress[];
  nativeSubagents: Record<string, NativeSubagentActivity>;
  onSelectSession?: (sessionId: string) => void;
  workspacePath?: string | null;
  onOpenArtifact?: (path: string) => void;
  onLoadResult: (ref: SessionToolResultRef) => Promise<void>;
}

interface ExecutionActivityBlockProps extends Omit<ExecutionTraceContentProps, "messages" | "renderContent" | "runtimeProgress" | "nativeSubagents"> {
  id: string;
  summary?: string;
  items: ToolCallGroupItem[];
}

function ExecutionActivityPreview({ summary, active }: { summary: string; active: boolean }) {
  return <span className={`execution-activity-block__preview${active ? " execution-activity-block__preview--active" : ""}`}>{summary}</span>;
}

export function ExecutionActivityPlaceholder({ summary = "正在处理这条消息" }: { summary?: string }) {
  return <div className="execution-activity-block">
    <div className="execution-activity-block__summary" role="status" aria-busy="true" aria-label={`${summary}，执行中`}>
      <ExecutionActivityPreview summary={summary} active />
    </div>
  </div>;
}

export function ExecutionActivityBlock({ id, summary = "执行操作", items, active = false, ...handlers }: ExecutionActivityBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const errors = items.filter(({ toolCall }) => toolCall.isError).length;
  return <div className="execution-activity-block" data-activity-id={id}>
    <button type="button" className="execution-activity-block__summary"
      aria-expanded={expanded} aria-controls={contentId} aria-busy={active || undefined}
      aria-label={`${summary}，${items.length} 项${active ? "，执行中" : ""}，${expanded ? "收起" : "展开"}`} title={summary}
      onClick={() => setExpanded((value) => !value)}>
      <ExecutionActivityPreview summary={summary} active={active} />
      {errors > 0 && <span className="execution-activity-block__error">{errors} 项失败</span>}
      <ChevronRight size={12} className="execution-activity-block__chevron" aria-hidden="true" />
    </button>
    {expanded && <div className="execution-activity-block__items" id={contentId}>
      {items.map((item) => <ToolCallActivity key={item.toolCall.id} {...item} {...handlers} />)}
    </div>}
  </div>;
}

export function ExecutionTraceContent({
  messages,
  active = false,
  renderContent,
  runtimeProgress,
  nativeSubagents,
  onSelectSession,
  workspacePath,
  onOpenArtifact,
  onLoadResult,
}: ExecutionTraceContentProps) {
  const rows = useMemo(() => {
    const previousReadResults = new Map<string, string>();
    return executionActivityRows(messages).map((row) => {
      if (row.kind === "commentary") return row;
      const items = row.toolCalls.map((toolCall) => {
        const filePath = typeof toolCall.arguments.file_path === "string"
          ? toolCall.arguments.file_path
          : undefined;
        const beforeContent = toolCall.name === "write_file" && filePath
          ? previousReadResults.get(filePath)
          : undefined;
        if (toolCall.name === "read_file" && filePath && toolCall.result !== undefined && !toolCall.isError) {
          previousReadResults.set(filePath, toolCall.result);
        }
        return {
          toolCall,
          beforeContent,
          progress: toolRuntimeProgress(runtimeProgress, toolCall.id),
          nativeSubagent: nativeSubagents[toolCall.id],
        };
      });
      return { ...row, items };
    });
  }, [messages, nativeSubagents, runtimeProgress]);

  const lastRow = rows.at(-1);
  const pendingSummary = active && lastRow?.kind !== "activity";
  const summaryStart = lastRow ? messages.findIndex((message) => message.id === lastRow.id) : 0;
  if (rows.length === 0) {
    return active
      ? <ExecutionActivityPlaceholder summary={latestExecutionSummary(messages)} />
      : <div className="execution-trace__empty">这一轮没有可显示的执行过程</div>;
  }

  return (
    <div className="execution-trace__timeline">
      {rows.map((row) => <div key={`${row.kind}:${row.id}`} className="execution-trace__item">
        {row.kind === "commentary"
          ? <div className="execution-trace__commentary">{renderContent(row.content)}</div>
          : <ExecutionActivityBlock id={row.id} summary={row.summary} items={row.items} active={active && row === lastRow}
              onSelectSession={onSelectSession} workspacePath={workspacePath} onOpenArtifact={onOpenArtifact} onLoadResult={onLoadResult} />}
      </div>)}
      {pendingSummary && <ExecutionActivityPlaceholder summary={latestExecutionSummary(messages.slice(Math.max(0, summaryStart)))} />}
    </div>
  );
}
