import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  NativeSubagentActivity,
  RuntimeProgress,
  SessionToolResultBody,
  SessionToolResultRef,
} from "@agent/core";
import { ChevronRight, CircleAlert, LoaderCircle, Workflow } from "lucide-react";
import type { ChatMessage } from "../stores/agentStore";
import {
  applyCodexExecutionToolResult,
  codexExecutionItemCount,
  mergeCodexExecutionMessages,
} from "../lib/codex-execution-trace";
import { coalesceAdjacentToolCallMessages, groupAdjacentToolCallEntries } from "../lib/tool-call-groups";
import { toolRuntimeProgress } from "../lib/native-runtime-progress";
import ReasoningSummary from "./ReasoningSummary";
import ToolCallCard, { ToolCallGroup } from "./ToolCallCard";

interface CodexExecutionTraceProps {
  trace: NonNullable<ChatMessage["executionTrace"]>;
  loadTrace: (trace: NonNullable<ChatMessage["executionTrace"]>) => Promise<ChatMessage[]>;
  loadToolResult: (ref: SessionToolResultRef) => Promise<SessionToolResultBody>;
  renderContent: (text: string) => ReactNode;
  runtimeProgress: RuntimeProgress[];
  nativeSubagents: Record<string, NativeSubagentActivity>;
  onSelectSession?: (sessionId: string) => void;
  workspacePath?: string | null;
  enableFilePreview?: boolean;
}

export default function CodexExecutionTrace({
  trace,
  loadTrace,
  loadToolResult,
  renderContent,
  runtimeProgress,
  nativeSubagents,
  onSelectSession,
  workspacePath,
  enableFilePreview = false,
}: CodexExecutionTraceProps) {
  const scope = trace.turnId;
  const scopeRef = useRef(scope);
  const revisionRef = useRef(trace.revision);
  const pendingRef = useRef<Promise<ChatMessage[]> | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    scopeRef.current = scope;
    pendingRef.current = null;
    setExpanded(false);
    setLoading(false);
    setMessages(null);
    setError(null);
  }, [scope]);

  useEffect(() => {
    revisionRef.current = trace.revision;
    pendingRef.current = null;
    setLoading(false);
    setMessages((current) => current?.map((message) => ({
      ...message,
      toolCalls: message.toolCalls?.map((toolCall) => toolCall.resultRef
        ? { ...toolCall, resultRef: { ...toolCall.resultRef, revision: trace.revision } }
        : toolCall),
    })) ?? null);
  }, [trace.revision]);

  const liveMessages = trace.liveMessages ?? [];
  const displayMessages = useMemo(
    () => mergeCodexExecutionMessages(messages ?? [], liveMessages),
    [liveMessages, messages],
  );
  const hasMessages = messages !== null || liveMessages.length > 0;

  const ensureLoaded = useCallback(async () => {
    if (messages) return messages;
    if (liveMessages.length > 0) return liveMessages;
    if (pendingRef.current) return pendingRef.current;
    const requestedScope = scope;
    const requestedRevision = trace.revision;
    setLoading(true);
    setError(null);
    const pending = loadTrace(trace);
    pendingRef.current = pending;
    try {
      const loaded = await pending;
      if (scopeRef.current === requestedScope && revisionRef.current === requestedRevision) setMessages(loaded);
      return loaded;
    } catch (loadError) {
      if (scopeRef.current === requestedScope && revisionRef.current === requestedRevision) {
        setError(loadError instanceof Error ? loadError.message : "执行过程加载失败");
      }
      throw loadError;
    } finally {
      if (scopeRef.current === requestedScope && revisionRef.current === requestedRevision) {
        pendingRef.current = null;
        setLoading(false);
      }
    }
  }, [liveMessages, loadTrace, messages, scope, trace]);

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && !hasMessages) void ensureLoaded().catch(() => undefined);
  };

  const loadLocalToolResult = useCallback(async (ref: SessionToolResultRef) => {
    const body = await loadToolResult(ref);
    if (scopeRef.current !== scope) return;
    setMessages((current) => current
      ? applyCodexExecutionToolResult(current, ref.itemId, body.content, body.isError)
      : current);
  }, [loadToolResult, scope]);

  const itemCount = hasMessages ? codexExecutionItemCount(displayMessages) : null;
  const label = itemCount !== null
    ? `执行过程 · ${itemCount} 项`
    : loading
      ? "执行过程加载中"
      : "执行过程";

  return (
    <div className="codex-execution-trace" data-turn-id={trace.turnId}>
      <button
        type="button"
        className="codex-execution-trace__summary"
        aria-expanded={expanded}
        aria-label={`${label}，${expanded ? "收起" : "展开"}`}
        onClick={toggle}
      >
        <span className="codex-execution-trace__icon" aria-hidden="true">
          {loading
            ? <LoaderCircle size={14} strokeWidth={2} />
            : error
              ? <CircleAlert size={14} strokeWidth={2} />
              : <Workflow size={14} strokeWidth={1.8} />}
        </span>
        <span className="codex-execution-trace__label">{label}</span>
        {error && <span className="codex-execution-trace__error">加载失败</span>}
        <span className="codex-execution-trace__spacer" />
        <ChevronRight className="codex-execution-trace__chevron" size={13} strokeWidth={2.2} aria-hidden="true" />
      </button>
      {expanded && (
        <div className="codex-execution-trace__body">
          {error && !hasMessages ? (
            <button
              type="button"
              className="ui-text-button codex-execution-trace__retry"
              onClick={() => void ensureLoaded().catch(() => undefined)}
            >
              重新加载执行过程
            </button>
          ) : hasMessages ? (
            <CodexExecutionTraceContent
              messages={displayMessages}
              renderContent={renderContent}
              runtimeProgress={runtimeProgress}
              nativeSubagents={nativeSubagents}
              onSelectSession={onSelectSession}
              workspacePath={workspacePath}
              enableFilePreview={enableFilePreview}
              onLoadResult={loadLocalToolResult}
            />
          ) : loading ? (
            <div className="codex-execution-trace__loading" role="status">正在加载这一轮的执行过程</div>
          ) : null}
        </div>
      )}
    </div>
  );
}

interface CodexExecutionTraceContentProps {
  messages: ChatMessage[];
  renderContent: (text: string) => ReactNode;
  runtimeProgress: RuntimeProgress[];
  nativeSubagents: Record<string, NativeSubagentActivity>;
  onSelectSession?: (sessionId: string) => void;
  workspacePath?: string | null;
  enableFilePreview: boolean;
  onLoadResult: (ref: SessionToolResultRef) => Promise<void>;
}

export function CodexExecutionTraceContent({
  messages,
  renderContent,
  runtimeProgress,
  nativeSubagents,
  onSelectSession,
  workspacePath,
  enableFilePreview,
  onLoadResult,
}: CodexExecutionTraceContentProps) {
  const rows = useMemo(() => {
    const previousReadResults = new Map<string, string>();
    return coalesceAdjacentToolCallMessages(messages).map((message) => {
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
        toolGroups: groupAdjacentToolCallEntries(toolEntries),
      };
    });
  }, [messages, nativeSubagents, runtimeProgress]);

  if (rows.length === 0) {
    return <div className="codex-execution-trace__empty">这一轮没有可显示的执行过程</div>;
  }

  return (
    <div className="codex-execution-trace__timeline">
      {rows.map(({ message, toolGroups }) => (
        <div key={message.id} className="codex-execution-trace__item">
          {message.presentation?.reasoning?.length ? (
            <ReasoningSummary
              sections={message.presentation.reasoning}
              renderContent={renderContent}
            />
          ) : null}
          {toolGroups.map((group) => group.action && group.items.length > 1 ? (
            <ToolCallGroup
              key={`group-${group.items[0].toolCall.id}`}
              items={group.items}
              onSelectSession={onSelectSession}
              workspacePath={workspacePath}
              enableFilePreview={enableFilePreview}
              onLoadResult={onLoadResult}
            />
          ) : group.items.map(({ toolCall, beforeContent, progress, nativeSubagent }) => (
            <ToolCallCard
              key={toolCall.id}
              toolCall={toolCall}
              beforeContent={beforeContent}
              progress={progress}
              nativeSubagent={nativeSubagent}
              onSelectSession={onSelectSession}
              workspacePath={workspacePath}
              enableFilePreview={enableFilePreview}
              onLoadResult={onLoadResult}
            />
          )))}
        </div>
      ))}
    </div>
  );
}
