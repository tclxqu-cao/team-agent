import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  NativeSubagentActivity,
  RuntimeProgress,
  SessionToolResultBody,
  SessionToolResultRef,
} from "@agent/core";
import { CircleAlert, LoaderCircle, Workflow } from "lucide-react";
import type { ChatMessage } from "../stores/agentStore";
import { executionActivityRows } from "../lib/execution-activity-blocks";
import {
  applyCodexExecutionToolResult,
  codexExecutionSegmentMessages,
  mergeCodexExecutionMessages,
} from "../lib/codex-execution-trace";
import ExecutionTrace, { ExecutionActivityPlaceholder, ExecutionTraceContent, useExecutionTraceDisclosure } from "./ExecutionTrace";

interface CodexExecutionTraceProps {
  trace: NonNullable<ChatMessage["executionTrace"]>;
  loadTrace: (trace: NonNullable<ChatMessage["executionTrace"]>) => Promise<ChatMessage[]>;
  loadToolResult: (ref: SessionToolResultRef) => Promise<SessionToolResultBody>;
  renderContent: (text: string) => ReactNode;
  runtimeProgress: RuntimeProgress[];
  nativeSubagents: Record<string, NativeSubagentActivity>;
  onSelectSession?: (sessionId: string) => void;
  workspacePath?: string | null;
  onOpenArtifact?: (path: string) => void;
  refreshSignal?: number;
  autoLoad?: boolean;
  isRunning?: boolean;
  active?: boolean;
  durationMs?: number;
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
  onOpenArtifact,
  refreshSignal = 0,
  autoLoad = false,
  isRunning = false,
  active = isRunning,
  durationMs,
}: CodexExecutionTraceProps) {
  const segmentIndex = trace.segmentIndex ?? 0;
  const scope = `${trace.turnId}:${segmentIndex}`;
  const scopeRef = useRef(scope);
  const revisionRef = useRef(trace.revision);
  const handledRefreshSignalRef = useRef(refreshSignal);
  const autoLoadAttemptRef = useRef<string | null>(null);
  const pendingRef = useRef<Promise<ChatMessage[]> | null>(null);
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [loadedToolResults, setLoadedToolResults] = useState<Record<string, SessionToolResultBody>>({});
  const [error, setError] = useState<string | null>(null);
  const { expanded, setExpanded } = useExecutionTraceDisclosure(scope, isRunning);

  useEffect(() => {
    scopeRef.current = scope;
    pendingRef.current = null;
    setLoading(false);
    setMessages(null);
    setLoadedToolResults({});
    setError(null);
    handledRefreshSignalRef.current = refreshSignal;
    autoLoadAttemptRef.current = null;
  }, [scope]);

  useEffect(() => {
    revisionRef.current = trace.revision;
    autoLoadAttemptRef.current = null;
    pendingRef.current = null;
    setLoading(false);
    setError(null);
    setMessages((current) => current?.map((message) => ({
      ...message,
      toolCalls: message.toolCalls?.map((toolCall) => toolCall.resultRef
        ? { ...toolCall, resultRef: { ...toolCall.resultRef, revision: trace.revision } }
        : toolCall),
    })) ?? null);
  }, [trace.revision]);

  // A resumed stream starts at the run's beginning. Wait for native ownership
  // before showing replayed items beneath a later input in the same turn.
  const liveMessages = messages === null && segmentIndex > 0
    && trace.historyItemKeys === undefined && !trace.revision.startsWith("live:")
    ? [] : trace.liveMessages ?? [];
  const persistedMessages = useMemo(
    () => codexExecutionSegmentMessages(messages ?? [], segmentIndex),
    [messages, segmentIndex],
  );
  const displayMessages = useMemo(() => Object.entries(loadedToolResults).reduce(
    (current, [itemId, body]) => applyCodexExecutionToolResult(current, itemId, body.content, body.isError),
    mergeCodexExecutionMessages(persistedMessages, liveMessages),
  ), [liveMessages, loadedToolResults, persistedMessages]);
  const hasActivity = useMemo(() => executionActivityRows(displayMessages).length > 0, [displayMessages]);
  const hasMessages = messages !== null || liveMessages.length > 0;
  const needsHistory = expanded && (autoLoad || !isRunning)
    && messages === null && !trace.revision.startsWith("live:");

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
    if (!needsHistory) return;
    const attempt = `${scope}:${trace.revision}`;
    if (autoLoadAttemptRef.current === attempt) return;
    autoLoadAttemptRef.current = attempt;
    void ensureLoaded(true).catch(() => undefined);
  }, [ensureLoaded, needsHistory, scope, trace.revision]);

  useEffect(() => {
    if (!expanded || error || (!hasMessages && !autoLoad) || refreshSignal === 0) return;
    if (handledRefreshSignalRef.current === refreshSignal) return;
    handledRefreshSignalRef.current = refreshSignal;
    void ensureLoaded(true).catch(() => undefined);
  }, [autoLoad, ensureLoaded, error, expanded, hasMessages, refreshSignal]);

  const loadLocalToolResult = useCallback(async (ref: SessionToolResultRef) => {
    const body = await loadToolResult(ref);
    if (scopeRef.current !== scope) return;
    // Keep on-demand bodies separate from native snapshots: a live segment may
    // not have loaded persisted history yet, and later snapshots stay lazy.
    setLoadedToolResults((current) => ({ ...current, [ref.itemId]: body }));
  }, [loadToolResult, scope]);

  const loadLabel = loading
    ? "正在加载执行过程"
    : error
      ? "重新加载执行过程"
      : "查看执行过程";

  // Unknown native history stays lazy; hide only a completed, known-empty trace.
  const hasUnloadedHistory = messages === null && !trace.revision.startsWith("live:")
    && (trace.historyItemKeys === undefined
      || trace.historyItemKeys.some((key) => key.startsWith("agent:") || key.startsWith("tool:")));
  if (!isRunning && !hasActivity && !hasUnloadedHistory && !error) return null;

  return (
    <ExecutionTrace
      turnId={trace.turnId}
      isRunning={isRunning}
      durationMs={durationMs}
      expanded={expanded}
      onToggle={() => setExpanded((value) => !value)}
    >
      {hasMessages && needsHistory && !error && (
        <div className="execution-trace__status" role="status" aria-live="polite" aria-busy="true">
          <LoaderCircle size={14} strokeWidth={2} aria-hidden="true" />
          <span className="execution-trace__label">正在加载执行过程</span>
        </div>
      )}
      {hasMessages ? (
        <ExecutionTraceContent
          messages={displayMessages}
          active={active && isRunning}
          renderContent={renderContent}
          runtimeProgress={runtimeProgress}
          nativeSubagents={nativeSubagents}
          onSelectSession={onSelectSession}
          workspacePath={workspacePath}
          onOpenArtifact={onOpenArtifact}
          onLoadResult={loadLocalToolResult}
        />
      ) : active && isRunning && !error ? (
        <ExecutionActivityPlaceholder />
      ) : (autoLoad || needsHistory) && !error ? (
        <div
          className="execution-trace__status"
          role="status"
          aria-live="polite"
          aria-busy="true"
        >
          <span className="execution-trace__icon" aria-hidden="true">
            <LoaderCircle size={14} strokeWidth={2} />
          </span>
          <span className="execution-trace__label">正在加载会话</span>
        </div>
      ) : (
        <button
          type="button"
          className="execution-trace__load"
          aria-busy={loading || undefined}
          disabled={loading}
          onClick={() => void ensureLoaded().catch(() => undefined)}
        >
          <span className="execution-trace__icon" aria-hidden="true">
            {loading
              ? <LoaderCircle size={14} strokeWidth={2} />
              : error
                ? <CircleAlert size={14} strokeWidth={2} />
                : <Workflow size={14} strokeWidth={1.8} />}
          </span>
          <span className="execution-trace__label">{loadLabel}</span>
          {error && <span className="execution-trace__error">加载失败</span>}
        </button>
      )}
    </ExecutionTrace>
  );
}
