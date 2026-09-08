import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  NativeSubagentActivity,
  RuntimeProgress,
  SessionToolResultBody,
  SessionToolResultRef,
} from "@agent/core";
import { CircleAlert, LoaderCircle, Workflow } from "lucide-react";
import type { ChatMessage } from "../stores/agentStore";
import {
  applyCodexExecutionToolResult,
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
  refreshSignal?: number;
  autoLoad?: boolean;
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
  refreshSignal = 0,
  autoLoad = false,
}: CodexExecutionTraceProps) {
  const scope = trace.turnId;
  const scopeRef = useRef(scope);
  const revisionRef = useRef(trace.revision);
  const handledRefreshSignalRef = useRef(refreshSignal);
  const pendingRef = useRef<Promise<ChatMessage[]> | null>(null);
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    scopeRef.current = scope;
    pendingRef.current = null;
    setLoading(false);
    setMessages(null);
    setError(null);
    handledRefreshSignalRef.current = refreshSignal;
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

  const ensureLoaded = useCallback(async (force = false) => {
    if (!force && messages) return messages;
    if (!force && liveMessages.length > 0) return liveMessages;
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

  useEffect(() => {
    if (!autoLoad || hasMessages) return;
    void ensureLoaded().catch(() => undefined);
  }, [autoLoad, ensureLoaded, hasMessages]);

  useEffect(() => {
    if ((!hasMessages && !autoLoad) || refreshSignal === 0) return;
    if (handledRefreshSignalRef.current === refreshSignal) return;
    handledRefreshSignalRef.current = refreshSignal;
    void ensureLoaded(true).catch(() => undefined);
  }, [autoLoad, ensureLoaded, hasMessages, refreshSignal]);

  const loadLocalToolResult = useCallback(async (ref: SessionToolResultRef) => {
    const body = await loadToolResult(ref);
    if (scopeRef.current !== scope) return;
    setMessages((current) => current
      ? applyCodexExecutionToolResult(current, ref.itemId, body.content, body.isError)
      : current);
  }, [loadToolResult, scope]);

  const loadLabel = loading
    ? "正在加载执行过程"
    : error
      ? "重新加载执行过程"
      : "查看执行过程";

  return (
    <div className="codex-execution-trace" data-turn-id={trace.turnId}>
      {hasMessages ? (
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
      ) : autoLoad && !error ? (
        <div
          className="codex-execution-trace__status"
          role="status"
          aria-live="polite"
          aria-busy="true"
        >
          <span className="codex-execution-trace__icon" aria-hidden="true">
            <LoaderCircle size={14} strokeWidth={2} />
          </span>
          <span className="codex-execution-trace__label">正在加载会话</span>
        </div>
      ) : (
        <button
          type="button"
          className="codex-execution-trace__load"
          aria-busy={loading || undefined}
          disabled={loading}
          onClick={() => void ensureLoaded().catch(() => undefined)}
        >
          <span className="codex-execution-trace__icon" aria-hidden="true">
            {loading
              ? <LoaderCircle size={14} strokeWidth={2} />
              : error
                ? <CircleAlert size={14} strokeWidth={2} />
                : <Workflow size={14} strokeWidth={1.8} />}
          </span>
          <span className="codex-execution-trace__label">{loadLabel}</span>
          {error && <span className="codex-execution-trace__error">加载失败</span>}
        </button>
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
          {message.presentation?.agentMessagePhase === "commentary" && message.content ? (
            <div className="codex-execution-trace__commentary">
              {renderContent(message.content)}
            </div>
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
          ) : (
            <ToolCallCard
              key={group.items[0].toolCall.id}
              toolCall={group.items[0].toolCall}
              beforeContent={group.items[0].beforeContent}
              progress={group.items[0].progress}
              nativeSubagent={group.items[0].nativeSubagent}
              onSelectSession={onSelectSession}
              workspacePath={workspacePath}
              enableFilePreview={enableFilePreview}
              onLoadResult={onLoadResult}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
