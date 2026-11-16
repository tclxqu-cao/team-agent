import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import type { NativeSubagentActivity, RuntimeProgress, SessionToolResultRef } from "@agent/core";
import { ChevronRight, LoaderCircle } from "lucide-react";
import type { ChatMessage } from "../stores/agentStore";
import { executionActivityRows } from "../lib/execution-activity-blocks";
import { hasToolCallResult } from "../lib/tool-call-status";
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

export function ExecutionActivityBlock({ id, summary = "执行操作", items, ...handlers }: ExecutionActivityBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const pending = items.some(({ toolCall }) => !hasToolCallResult(toolCall));
  const errors = items.filter(({ toolCall }) => toolCall.isError).length;
  return <div className="execution-activity-block" data-activity-id={id}>
    <button type="button" className="execution-activity-block__summary"
      aria-expanded={expanded} aria-controls={contentId} aria-busy={pending || undefined}
      aria-label={`${summary}，${items.length} 项，${expanded ? "收起" : "展开"}`} title={summary}
      onClick={() => setExpanded((value) => !value)}>
      <span className="execution-activity-block__preview">{summary}</span>
      {pending && <LoaderCircle size={12} className="animate-spin" aria-hidden="true" />}
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

  if (rows.length === 0) {
    return <div className="execution-trace__empty">这一轮没有可显示的执行过程</div>;
  }

  return (
    <div className="execution-trace__timeline">
      {rows.map((row) => <div key={`${row.kind}:${row.id}`} className="execution-trace__item">
        {row.kind === "commentary"
          ? <div className="execution-trace__commentary">{renderContent(row.content)}</div>
          : <ExecutionActivityBlock id={row.id} summary={row.summary} items={row.items}
              onSelectSession={onSelectSession} workspacePath={workspacePath} onOpenArtifact={onOpenArtifact} onLoadResult={onLoadResult} />}
      </div>)}
    </div>
  );
}
