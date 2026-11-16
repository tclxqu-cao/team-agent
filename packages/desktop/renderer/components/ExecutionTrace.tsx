import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import type { NativeSubagentActivity, RuntimeProgress, SessionToolResultRef } from "@agent/core";
import { ChevronRight } from "lucide-react";
import type { ChatMessage } from "../stores/agentStore";
import { coalesceAdjacentToolCallMessages } from "../lib/tool-call-groups";
import { toolRuntimeProgress } from "../lib/native-runtime-progress";
import { formatSessionWorkDuration } from "../lib/session-execution-summary";
import ReasoningSummary from "./ReasoningSummary";
import { ToolCallGroup } from "./ToolCallCard";

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
    const visibleMessages = messages.filter((message) => (
      message.toolCalls?.length
      || message.presentation?.reasoning?.some((section) => section.text.trim())
      || (message.presentation?.agentMessagePhase === "commentary" && message.content.trim())
    ));
    return coalesceAdjacentToolCallMessages(visibleMessages).map((message) => {
      const toolEntries = (message.toolCalls ?? []).map((toolCall) => {
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
      return {
        message,
        toolEntries,
      };
    });
  }, [messages, nativeSubagents, runtimeProgress]);

  if (rows.length === 0) {
    return <div className="execution-trace__empty">这一轮没有可显示的执行过程</div>;
  }

  return (
    <div className="execution-trace__timeline">
      {rows.map(({ message, toolEntries }) => (
        <div key={message.id} className="execution-trace__item">
          {message.presentation?.reasoning?.length ? (
            <ReasoningSummary
              sections={message.presentation.reasoning}
              renderContent={renderContent}
              variant="inline"
            />
          ) : null}
          {message.presentation?.agentMessagePhase === "commentary" && message.content.trim() ? (
            <div className="execution-trace__commentary">
              {renderContent(message.content.trim())}
            </div>
          ) : null}
          {toolEntries.length > 0 && (
            <ToolCallGroup
              key={`group-${toolEntries[0].toolCall.id}`}
              variant="activity"
              items={toolEntries}
              onSelectSession={onSelectSession}
              workspacePath={workspacePath}
              onOpenArtifact={onOpenArtifact}
              onLoadResult={onLoadResult}
            />
          )}
        </div>
      ))}
    </div>
  );
}
