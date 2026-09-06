import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AgentEvent, RuntimeProgress } from "@agent/core";
import { ArrowDownToLine, Check, Copy, CornerUpRight, FileText, GripVertical, LoaderCircle, Pencil, RefreshCw, Square, Target, Trash2, Volume2 } from "lucide-react";
import AgentBrandIcon from "./AgentBrandIcon";
import {
  isNativeAgentType,
  loadNativeRunPref,
  nativeModelFromKey,
  nativeModelKey,
  saveNativeRunPref,
  type NativeAgentRunPref,
} from "../lib/native-agent-run-prefs";
import {
  findLatestContextUsage,
  reduceNativeSubagentActivities,
  useAgentStore,
  type StreamEvent,
  type CronTask,
} from "../stores/agentStore";
import { useUIStore } from "../stores/uiStore";
import {
  startDictation,
  stopSpeaking,
  isASRSupported,
  type DictationHandle,
} from "../lib/speech";
import { interruptSpeech } from "../lib/voice-interruption";
import { PcmStreamPlayer } from "../lib/pcm-stream-player";
import {
  mergeRefreshedSessionHistory,
  restoreSessionHistoryPage,
  type SessionHistoryDetail,
} from "../lib/session-history";
import { SinglePageHistoryPrefetch } from "../lib/session-history-prefetch";
import { QueryNavigationRail } from "./QueryNavigationRail";
import type { SessionQueryIndex, SessionQueryIndexEntry } from "../global";
import {
  describeSessionLoadError,
  loadSessionWithRetry,
} from "../lib/session-load-recovery";
import { normalizeComposerImage } from "../lib/browser-image-normalization";
import { supportsMidTurnSteering } from "../lib/runtime-capabilities";
import { copyTextToClipboard } from "../lib/clipboard";
import { clearSessionDraft, readSessionDraft, writeSessionDraft } from "../lib/session-draft";
import { postWebArtifactOpen, resolveWebArtifactPath } from "../lib/artifact-links";
import {
  findLatestUnqueuedUserMessageId,
  hideQueuedGoalMessages,
  moveQueuedMessage,
  projectSessionGoals,
  reconcileDurableQueuedMessages,
} from "../lib/queued-message-order";
import { isWebShell } from "../web/webLayout";
import {
  latestGlobalRuntimeProgress,
  reduceRuntimeProgressEvents,
  toolRuntimeProgress,
} from "../lib/native-runtime-progress";
import {
  isActiveNativeSession,
  isNativeRuntimeSelection,
  isObservedNativeRun,
  shouldFollowNativeHistory,
  shouldQueueMessageForActiveRun,
  shouldRestoreLocalNativeRun,
} from "../lib/native-session-view-state";

const SESSION_HISTORY_PAGE_SIZE = 50;

function normalizeGoalMessageText(value: string): string {
  return value.trim().replace(/^\/goal\s+/i, "").replace(/^\$([\w-]+)/, "/$1").trim();
}

/** Human-readable description of a cron/interval expression (browser-safe, no Node.js). */
function describeCron(cron: string): string {
  const cleaned = cron.trim().replace(/^每(?:隔)?/, '');
  const m = cleaned.match(/^(\d+(?:\.\d+)?)\s*(s|sec|秒|m|min|分钟?|h|hr|小时)$/i);
  if (m) {
    const n = parseFloat(m[1]);
    const u = m[2].toLowerCase();
    const ms = (u === 's' || u === 'sec' || u === '秒') ? n * 1000
      : (u === 'm' || u === 'min' || u === '分' || u === '分钟') ? n * 60_000
      : n * 3_600_000;
    if (ms >= 3_600_000 && ms % 3_600_000 === 0) return `每 ${ms / 3_600_000} 小时`;
    if (ms >= 60_000 && ms % 60_000 === 0) return `每 ${ms / 60_000} 分钟`;
    return `每 ${ms / 1000} 秒`;
  }
  const [min, hour] = cron.trim().split(/\s+/);
  if (min === '0' && hour && hour !== '*' && !hour.includes('/') && !hour.includes(','))
    return `每天 ${hour.padStart(2, '0')}:00`;
  return `cron: ${cron}`;
}

/** Render inline backtick code spans within a single line of text. */
function renderInlineCode(text: string): React.ReactNode {
  const parts = text.split(/(`[^`\n]+`)/g);
  if (parts.length <= 1) return text;
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <code key={i} style={{ fontFamily: 'var(--font-mono)', fontSize: '0.84em', background: 'rgba(17,24,39,0.06)', padding: '1px 5px', borderRadius: 4, color: 'var(--accent)', border: '1px solid var(--border-subtle)' }}>
            {part.slice(1, -1)}
          </code>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}

function renderEmphasis(text: string, keyPrefix: string): React.ReactNode[] {
  const tokens = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g);
  return tokens.map((token, index) => {
    const key = `${keyPrefix}-${index}`;
    if (token.startsWith('**') && token.endsWith('**') && token.length > 4) {
      return <strong key={key} style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{token.slice(2, -2)}</strong>;
    }
    if (token.startsWith('*') && token.endsWith('*') && token.length > 2) {
      return <em key={key}>{token.slice(1, -1)}</em>;
    }
    return <span key={key}>{token}</span>;
  });
}

function renderInlineLabel(text: string, keyPrefix: string): React.ReactNode {
  const codeParts = text.split(/(`[^`\n]+`)/g);
  return codeParts.map((part, index) => {
    if (index % 2 === 1) {
      return (
        <code key={`${keyPrefix}-${index}`} style={{ fontFamily: 'var(--font-mono)', fontSize: '0.84em', background: 'rgba(17,24,39,0.06)', padding: '1px 5px', borderRadius: 4, color: 'var(--accent)', border: '1px solid var(--border-subtle)' }}>
          {part.slice(1, -1)}
        </code>
      );
    }
    return renderEmphasis(part, `${keyPrefix}-${index}`);
  });
}

/** Render inline markdown: links, `code`, **bold**, *italic* within a single line. */
function renderRichInline(text: string): React.ReactNode {
  return parseRichInlineTokens(text).map((token, index) => {
    if (token.type === "code") {
      return (
        <code key={index} style={{ fontFamily: 'var(--font-mono)', fontSize: '0.84em', background: 'rgba(17,24,39,0.06)', padding: '1px 5px', borderRadius: 4, color: 'var(--accent)', border: '1px solid var(--border-subtle)' }}>
          {token.value}
        </code>
      );
    }
    if (token.type === "link") {
      return (
        <a
          key={index}
          className="chat-message-link"
          href={token.href}
          target="_blank"
          rel="noopener noreferrer"
        >
          {renderInlineLabel(token.label, `${index}-label`)}
        </a>
      );
    }
    if (token.type === "artifact") {
      if (!isWebShell()) return <span key={index}>{token.raw}</span>;
      const locationLabel = token.line ? `${token.path}:${token.line}` : token.path;
      const accessibleLabel = token.label.replace(/^`([^`\n]+)`$/, "$1");
      return (
        <button
          key={index}
          type="button"
          className="chat-message-artifact-link"
          title={locationLabel}
          aria-label={`打开交付物 ${accessibleLabel}`}
          onClick={() => postWebArtifactOpen(token.path)}
        >
          <FileText size={16} strokeWidth={1.8} aria-hidden="true" />
          <span>{renderInlineLabel(token.label, `${index}-label`)}</span>
        </button>
      );
    }
    return renderEmphasis(token.value, `${index}`);
  });
}

/** Parse a Markdown table block into header + rows. Returns null if not a valid table. */
function parseMarkdownTable(lines: string[]): { headers: string[]; rows: string[][] } | null {
  if (lines.length < 2) return null;
  const parseRow = (line: string) =>
    line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
  const headers = parseRow(lines[0]);
  // Second line must be a separator like |---|---|
  const sep = lines[1].replace(/^\|/, '').replace(/\|$/, '');
  if (!/^[\s\-:|]+$/.test(sep)) return null;
  const rows = lines.slice(2).map(parseRow);
  return { headers, rows };
}

/** Render a parsed Markdown table as a styled HTML table. */
function renderMarkdownTable(headers: string[], rows: string[][]): React.ReactNode {
  const cellStyle = (isHeader: boolean): React.CSSProperties => ({
    padding: '6px 14px',
    textAlign: 'left',
    fontSize: 13,
    fontWeight: isHeader ? 600 : 400,
    color: isHeader ? 'var(--text-primary)' : 'var(--text-secondary)',
    borderBottom: '1px solid var(--border-subtle)',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  });
  return (
    <div style={{
      margin: '8px 0',
      borderRadius: 'var(--radius-sm)',
      border: '1px solid var(--border-subtle)',
      overflow: 'auto',
      background: 'var(--bg-surface)',
    }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}>
        <thead>
          <tr style={{ background: 'var(--bg-deep)' }}>
            {headers.map((h, i) => (
              <th key={i} style={cellStyle(true)}>{renderRichInline(h)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} style={{ background: ri % 2 === 0 ? 'transparent' : 'rgba(0,0,0,0.015)' }}>
              {row.map((cell, ci) => (
                <td key={ci} style={cellStyle(false)}>{renderRichInline(cell)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Render a fenced code block (```lang ... ```) as a labeled code panel. */
function renderCodeFence(lang: string, code: string): React.ReactNode {
  return (
    <div style={{ margin: '8px 0', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-subtle)', overflow: 'hidden', background: 'var(--bg-surface)' }}>
      <div style={{ padding: '4px 10px', background: 'var(--bg-deep)', borderBottom: '1px solid var(--border-subtle)', fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em' }}>
        {lang || 'code'}
      </div>
      <pre style={{ margin: 0, padding: '10px 12px', fontSize: 12, lineHeight: 1.6, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflow: 'auto', maxHeight: 420 }}>{code}</pre>
    </div>
  );
}

/** Render assistant message text: supports Markdown tables, links, fenced code blocks, `code`, **bold**, *italic*, and newlines. */
function renderAssistantText(text: string): React.ReactNode {
  const lines = text.split('\n');
  const segments: React.ReactNode[] = [];
  let i = 0;
  let segKey = 0;

  const isFenceStart = (line: string) => line.trimStart().startsWith('```');
  const isTableStart = (idx: number) =>
    lines[idx].trimStart().startsWith('|') && idx + 1 < lines.length && /^\|[\s\-:|]+\|$/.test(lines[idx + 1].trim());

  while (i < lines.length) {
    if (isFenceStart(lines[i])) {
      const lang = lines[i].trim().slice(3).trim();
      i++;
      const codeLines: string[] = [];
      while (i < lines.length && !isFenceStart(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      i++;
      segments.push(<div key={`code-${segKey++}`}>{renderCodeFence(lang, codeLines.join('\n'))}</div>);
      continue;
    }
    // Detect table block: line starts with '|' and next line is separator
    if (isTableStart(i)) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].trimStart().startsWith('|')) {
        tableLines.push(lines[i].trim());
        i++;
      }
      const parsed = parseMarkdownTable(tableLines);
      if (parsed) {
        segments.push(<div key={`tbl-${segKey++}`}>{renderMarkdownTable(parsed.headers, parsed.rows)}</div>);
      } else {
        // Fallback: render as plain text
        segments.push(<span key={`tbl-fb-${segKey++}`}>{tableLines.map((l, li) => (
          <span key={li}>{renderInlineCode(l)}{li < tableLines.length - 1 ? '\n' : null}</span>
        ))}</span>);
      }
    } else {
      // Collect non-table lines into a plain text block
      const plainLines: string[] = [];
      while (i < lines.length && !isTableStart(i) && !isFenceStart(lines[i])) {
        plainLines.push(lines[i]);
        i++;
      }
      if (plainLines.length > 0) {
        segments.push(
          <span key={`txt-${segKey++}`}>
            {plainLines.map((line, li) => (
              <span key={li}>{renderRichInline(line)}{li < plainLines.length - 1 ? '\n' : null}</span>
            ))}
          </span>
        );
      }
    }
  }

  return <>{segments}</>;
}

import { useSettingsStore } from "../stores/settingsStore";
import ToolCallCard, { ToolCallGroup } from "./ToolCallCard";
import AskUserCard from "./AskUserCard";
import ContextUsageBar from "./ContextUsageBar";
import AgentActivityIndicator from "./AgentActivityIndicator";
import ReasoningSummary from "./ReasoningSummary";
import RuntimeProgressRow from "./RuntimeProgressRow";
import ChatHeaderActions from "./ChatHeaderActions";
import EmptySessionWelcome from "./EmptySessionWelcome";
import MessageImageLightbox, { type MessageImagePreview } from "./MessageImageLightbox";
import { widgetRegistry } from "./widgets/index.js";
import { prepareVoiceCommand, shouldSkipVoiceSessionReload } from "../lib/voice-command";
import { prepareChatCommand } from "../lib/chat-command";
import { areToolCallsComplete } from "../lib/tool-call-status";
import { parseRichInlineTokens } from "../lib/markdown-links";
import { coalesceAdjacentToolCallMessages, groupAdjacentToolCallEntries } from "../lib/tool-call-groups";
import {
  formatCompletionDuration,
  messageActionPolicy,
  validCompletionDurationMs,
} from "../lib/message-actions";
import { prepareComposerFiles } from "../lib/composer-file-routing";
import {
  canForkOccupiedCodexSession,
  forkOccupiedCodexSession,
  isOccupiedSessionRecovery,
  type OccupiedSessionError,
} from "../lib/occupied-session-fork";
import type { AgentType, NativeReasoningEffort, RuntimeModelInfo, RuntimeModelSelection, SessionGoalState, ToolPermissionMode, UnifiedSessionSummary } from "../global";

interface ChatViewProps {
  activeAgentType?: AgentType;
  selectedProjectId?: string | null;
  selectedSessionId?: string | null;
  onSessionCreated?: (
    sessionId: string,
    pendingSession?: UnifiedSessionSummary,
  ) => void | Promise<void>;
  onMessageSent?: (sessionId: string, firstMessage: string) => void | Promise<void>;
  /** Called when a sub-session is created by agent_dispatch, with the parent session ID */
  onSubSessionCreated?: (parentSessionId: string) => void | Promise<void>;
  /** Navigate to a specific session (e.g., click a sub-session link) */
  onSelectSession?: (sessionId: string) => void;
  /** Fired when a sub-agent session starts, completes, or errors — used for toast notifications */
  onSubAgentEvent?: (ev: { type: 'started' | 'completed' | 'failed'; agentName: string; task: string; subSessionId?: string }) => void;
  onRunComplete?: (projectId: string | null, sessionId: string) => void | Promise<void>;
  sessionTitle?: string;
  sessionSummary?: UnifiedSessionSummary;
  workspacePath?: string | null;
  onOpenSettings?: () => void;
  settingsOpen?: boolean;
  onHideToBackground?: () => void;
  onToggleAppearance?: (anchor: DOMRect) => void;
  appearanceOpen?: boolean;
  hideToBackgroundTitle?: string;
  /** Voice command captured after the wake word — auto-creates a session
   *  (under the mentioned project when present) and runs the agent. When
   *  sessionId is set, the command continues that voice-conversation
   *  session instead of creating a new one. */
  voiceCommand?: { text: string; projectId: string | null; sessionId?: string | null; nonce: number } | null;
}

const EFFORT_OPTIONS: Array<{ value: "off" | "low" | "medium" | "high"; label: string }> = [
  { value: "off", label: "关" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
];
const EFFORT_LABELS = Object.fromEntries(EFFORT_OPTIONS.map((o) => [o.value, o.label])) as Record<"off" | "low" | "medium" | "high", string>;

/** One pickable model in the native-runtime composer dropdown. */
interface ComposerModelOption {
  key: string;
  label: string;
  model: RuntimeModelSelection;
  reasoningEfforts?: NativeReasoningEffort[];
}

const NATIVE_EFFORT_LABELS: Record<NativeReasoningEffort, string> = {
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "超高",
  max: "最大",
};

const NATIVE_AGENT_LABELS: Record<Exclude<AgentType, "customer-agent">, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  opencode: "OpenCode",
};

/** Settings profiles only transfer to a runtime whose provider they match (opencode understands all providers). */
function profileProviderMatches(provider: string, agentType: AgentType): boolean {
  if (agentType === "codex") return provider === "openai";
  if (agentType === "claude-code") return provider === "anthropic";
  return false;
}

const PERMISSION_OPTIONS: Array<{
  value: ToolPermissionMode;
  label: string;
  description: string;
}> = [
  { value: "request-approval", label: "请求批准", description: "编辑外部文件和使用互联网时始终询问" },
  { value: "auto-approval", label: "帮我批准", description: "仅对检测到的风险操作请求批准" },
  { value: "full-access", label: "完全访问权限", description: "可不受限制地访问互联网和你电脑上的任何文件" },
];

function normalizePermissionMode(value: unknown): ToolPermissionMode {
  return PERMISSION_OPTIONS.some((option) => option.value === value)
    ? value as ToolPermissionMode
    : "full-access";
}

export default function ChatView({
  activeAgentType = "customer-agent",
  selectedProjectId = null,
  selectedSessionId = null,
  onSessionCreated,
  onMessageSent,
  onSubSessionCreated,
  onSelectSession,
  onSubAgentEvent,
  onRunComplete,
  sessionTitle,
  sessionSummary,
  workspacePath = null,
  onOpenSettings,
  settingsOpen = false,
  onHideToBackground,
  onToggleAppearance,
  appearanceOpen = false,
  hideToBackgroundTitle,
  voiceCommand = null,
}: ChatViewProps) {
  const {
    messages,
    runningSessionId,
    appendText,
    addMessage,
    setRunningSession,
    setSessionId,
    updateToolResult,
    updateSubAgentStatus,
    updateSubAgentProgress,
    updateMessage,
    setMessages,
    getMessagesForSession,
    contextUsageBySession,
    runtimeProgressBySession,
    nativeSubagentsBySession,
    setContextUsage,
    applyRuntimeProgress,
    setRuntimeProgress,
    clearRuntimeProgress,
    applyNativeSubagentActivity,
    setNativeSubagentActivities,
    applyReasoningSummary,
    clearMessages,
    sessionId,
    todos,
    setTodos,
    cronTasks,
    setCronTasks,
  } = useAgentStore();
  const [goalState, setGoalState] = useState<SessionGoalState>({ active: null, queued: [], history: [] });
  const renderedMessages = useMemo(
    () => coalesceAdjacentToolCallMessages(hideQueuedGoalMessages(
      messages.filter((message) => !message.isQueued),
      goalState.queued,
    )),
    [goalState.queued, messages],
  );
  const { isConfigured, profiles, activeProfileId, switchActiveProfile, loadFromSystem, contextWindow, reasoningEffort, setField, saveToSystem } = useSettingsStore();
  const [sessionError, setSessionError] = useState<OccupiedSessionError>();
  const [occupiedDraft, setOccupiedDraft] = useState<string>();
  const [isForkingSession, setIsForkingSession] = useState(false);
  const [directCompatibilitySessionId, setDirectCompatibilitySessionId] = useState<string | null>(null);
  const [compatibilityFailure, setCompatibilityFailure] = useState<string | null>(null);
  const viewSessionId = selectedSessionId || sessionId;
  const isNativeRuntime = isNativeRuntimeSelection(sessionSummary, activeAgentType);
  const composerAgentType: AgentType = sessionSummary?.agentType ?? activeAgentType;

  // ── Native runtime model & reasoning-effort picker ──────────────────────
  // The choice is per agent type, lives in localStorage, and rides along with
  // every native run (see startRun); the model list comes from each runtime's
  // own connection via /api/agent/models.
  const [nativeModels, setNativeModels] = useState<RuntimeModelInfo[]>([]);
  const nativeModelsAgentRef = useRef<AgentType | null>(null);
  const [nativePref, setNativePref] = useState<NativeAgentRunPref>(() => loadNativeRunPref(composerAgentType));
  const [nativeEffortMenuOpen, setNativeEffortMenuOpen] = useState(false);
  const nativeEffortMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setNativePref(loadNativeRunPref(composerAgentType));
    setNativeEffortMenuOpen(false);
  }, [composerAgentType]);
  useEffect(() => {
    if (!isNativeRuntime || !window.agentApi?.listAgentModels) return;
    if (nativeModelsAgentRef.current === composerAgentType) return;
    nativeModelsAgentRef.current = composerAgentType;
    setNativeModels([]);
    void window.agentApi.listAgentModels(composerAgentType)
      .then((result) => setNativeModels(result.models ?? []))
      .catch(() => {
        setNativeModels([]);
        // Allow a retry when the composer renders this agent type again.
        nativeModelsAgentRef.current = null;
      });
  }, [isNativeRuntime, composerAgentType]);
  useEffect(() => {
    if (!nativeEffortMenuOpen) return;
    const onDown = (event: MouseEvent) => {
      if (nativeEffortMenuRef.current && !nativeEffortMenuRef.current.contains(event.target as Node)) {
        setNativeEffortMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [nativeEffortMenuOpen]);
  const updateNativePref = useCallback((patch: NativeAgentRunPref) => {
    setNativePref((prev) => {
      const next = { ...prev, ...patch };
      saveNativeRunPref(composerAgentType, next);
      return next;
    });
  }, [composerAgentType]);
  const runtimeModelOptions = useMemo<ComposerModelOption[]>(() => {
    if (!isNativeRuntime) return [];
    return nativeModels.map((model) => ({
      key: nativeModelKey(model),
      label: model.displayName || model.id,
      model: { id: model.id, ...(model.providerID ? { providerID: model.providerID } : {}) },
      reasoningEfforts: model.reasoningEfforts,
    }));
  }, [isNativeRuntime, nativeModels]);
  const profileModelOptions = useMemo<ComposerModelOption[]>(() => {
    if (!isNativeRuntime) return [];
    return (profiles ?? [])
      .filter((profile) => profile.modelId?.trim())
      .filter((profile) => composerAgentType === "opencode" || profileProviderMatches(profile.provider, composerAgentType))
      .map((profile) => ({
        key: composerAgentType === "opencode"
          ? nativeModelKey({ id: profile.modelId, providerID: profile.provider })
          : profile.modelId,
        label: profile.name || profile.modelId,
        model: {
          id: profile.modelId,
          ...(composerAgentType === "opencode" ? { providerID: profile.provider } : {}),
        },
      }));
  }, [isNativeRuntime, profiles, composerAgentType]);
  const selectedNativeModelKey = nativePref.model?.id ? nativeModelKey(nativePref.model) : "";
  const selectedModelEfforts = useMemo<NativeReasoningEffort[] | undefined>(() => {
    const selected = runtimeModelOptions.find((option) => option.key === selectedNativeModelKey);
    if (selected?.reasoningEfforts?.length) return selected.reasoningEfforts;
    if (composerAgentType === "claude-code") return ["low", "medium", "high", "xhigh"];
    return undefined;
  }, [runtimeModelOptions, selectedNativeModelKey, composerAgentType]);
  const nativeEffortOptions = useMemo<NativeReasoningEffort[]>(() => {
    if (!isNativeRuntime) return [];
    if (composerAgentType === "codex") return selectedModelEfforts ?? [];
    if (composerAgentType === "claude-code") return selectedModelEfforts ?? ["low", "medium", "high", "xhigh"];
    return [];
  }, [isNativeRuntime, composerAgentType, selectedModelEfforts]);
  const activeNativeEffort = nativePref.reasoningEffort
    && nativeEffortOptions.includes(nativePref.reasoningEffort)
    ? nativePref.reasoningEffort
    : undefined;
  const nativeModelPickerReady = runtimeModelOptions.length > 0 || profileModelOptions.length > 0;

  const hasDurableMessageQueue = sessionSummary?.messageQueueVersion === 1;
  const canSteerQueuedMessages = supportsMidTurnSteering(sessionSummary?.agentType);
  const compatibilityStatus = directCompatibilitySessionId === viewSessionId
    ? "direct"
    : compatibilityFailure
      ? "incompatible"
      : sessionSummary?.compatibility?.status;
  const isCompatibilityReadOnly = compatibilityStatus !== undefined && compatibilityStatus !== "direct";
  const isReadOnly = sessionSummary?.occupancy === "owned-externally" || isCompatibilityReadOnly;
  const isOccupiedRecovery = isOccupiedSessionRecovery(viewSessionId, sessionError);
  const runtimeReady = isConfigured || isNativeRuntime;
  const canCompose = runtimeReady && !isReadOnly && !isOccupiedRecovery;
  const runningSubIdsRef = useRef<Set<string>>(new Set());
  /** Tracks what the agent is currently doing: thinking, waiting for tools, or idle */
  const [agentActivity, setAgentActivity] = useState<"idle" | "thinking" | "tools">("idle");
  const agentActivityRef = useRef<"idle" | "thinking" | "tools">("idle");
  const thinkingSessionIdRef = useRef<string | null>(null);
  const [thinkingStartedAt, setThinkingStartedAt] = useState(() => Date.now());

  // Local ownership controls actions; externally observed activity remains visible.
  const isLocallyRunning = !!(
    viewSessionId
    && (runningSessionId === viewSessionId || runningSubIdsRef.current.has(viewSessionId))
  );
  const shouldQueueMessage = shouldQueueMessageForActiveRun(sessionSummary, isLocallyRunning);
  const isRunning = isLocallyRunning || isObservedNativeRun(sessionSummary);
  const runtimeProgress = viewSessionId ? runtimeProgressBySession[viewSessionId] ?? [] : [];
  const nativeSubagents = viewSessionId ? nativeSubagentsBySession[viewSessionId] ?? {} : {};
  const globalRuntimeProgress = latestGlobalRuntimeProgress(runtimeProgress);
  const latestRenderedMessage = renderedMessages[renderedMessages.length - 1];
  const hasStreamingReasoning = Boolean(
    latestRenderedMessage?.role === "assistant"
    && agentActivity === "thinking"
    && latestRenderedMessage.presentation?.reasoning?.some((section) => section.text.trim()),
  );
  const hasVisibleRunningTool = agentActivity === "tools" && renderedMessages.some((message) => (
    message.toolCalls?.length && !areToolCallsComplete(message.toolCalls)
  ));
  const showThinkingFallback = isRunning
    && !globalRuntimeProgress
    && !hasStreamingReasoning
    && !hasVisibleRunningTool;

  // Ensure profiles are loaded even if SettingsPanel was never opened
  useEffect(() => { loadFromSystem(); }, []);

  // Load cron tasks on mount
  useEffect(() => {
    if (!window.agentApi) return;
    void window.agentApi.cronList().then((list) => setCronTasks(list));
  }, []);

  const [input, setInput] = useState("");
  const [editingQueuedId, setEditingQueuedId] = useState<string | null>(null);
  const [queuedEditDraft, setQueuedEditDraft] = useState("");
  const [copiedQueuedId, setCopiedQueuedId] = useState<string | null>(null);
  const [draggedQueuedMessageId, setDraggedQueuedMessageId] = useState<string | null>(null);
  const queuedPointerDragRef = useRef<{ id: string; pointerId: number } | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [effortMenuOpen, setEffortMenuOpen] = useState(false);
  const [permissionMenuOpen, setPermissionMenuOpen] = useState(false);
  const [permissionMode, setPermissionMode] = useState<ToolPermissionMode>("full-access");
  const [goalMode, setGoalMode] = useState(false);
  const [draggedGoalId, setDraggedGoalId] = useState<string | null>(null);
  const [isSavingPermission, setIsSavingPermission] = useState(false);
  const effortMenuRef = useRef<HTMLDivElement>(null);
  const permissionMenuRef = useRef<HTMLDivElement>(null);
  const applySessionQueueState = useCallback((state: SessionGoalState, targetSessionId: string) => {
    const viewedSessionId = selectedSessionIdRef.current || sessionIdRef.current;
    if (targetSessionId === viewedSessionId) {
      setGoalState(projectSessionGoals(state) as SessionGoalState);
    }
    if (!targetSessionId.startsWith("runtime:")) return;
    const current = getMessagesForSession(targetSessionId);
    setMessages(
      reconcileDurableQueuedMessages(current, state),
      targetSessionId,
    );
  }, [getMessagesForSession, setMessages]);

  // Close the reasoning-effort menu on outside click
  useEffect(() => {
    if (!effortMenuOpen) return;
    const onDown = (event: MouseEvent) => {
      if (effortMenuRef.current && !effortMenuRef.current.contains(event.target as Node)) {
        setEffortMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [effortMenuOpen]);

  useEffect(() => {
    if (!permissionMenuOpen) return;
    const onDown = (event: MouseEvent) => {
      if (permissionMenuRef.current && !permissionMenuRef.current.contains(event.target as Node)) {
        setPermissionMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [permissionMenuOpen]);

  useEffect(() => {
    setPermissionMenuOpen(false);
    setPermissionMode(normalizePermissionMode(sessionSummary?.permissionMode));
  }, [isNativeRuntime, selectedSessionId, sessionSummary?.permissionMode]);
  const [error, setError] = useState<string | null>(null);
  const [sessionLoadError, setSessionLoadError] = useState<string | null>(null);
  const [sessionReloadGeneration, setSessionReloadGeneration] = useState(0);
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  /** Base64 data URLs of images to send with the next message */
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  const [pendingImageReads, setPendingImageReads] = useState(0);
  const [previewedMessageImage, setPreviewedMessageImage] = useState<MessageImagePreview | null>(null);
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const historyScrollTimerRef = useRef<number | null>(null);
  const loadOlderHistoryRef = useRef<() => void>(() => undefined);
  const loadNewerHistoryRef = useRef<() => void>(() => undefined);
  const historyCursorRef = useRef<string | null>(null);
  const latestHistoryCursorRef = useRef<string | null>(null);
  const historyPrefetchRef = useRef<SinglePageHistoryPrefetch<SessionHistoryDetail | null> | null>(null);
  if (!historyPrefetchRef.current) {
    historyPrefetchRef.current = new SinglePageHistoryPrefetch<SessionHistoryDetail | null>();
  }
  const historySessionIdRef = useRef<string | null>(null);
  const historyWindowModeRef = useRef<"latest" | "anchored">("latest");
  const anchoredNewerCursorRef = useRef<string | null>(null);
  const isLoadingNewerHistoryRef = useRef(false);
  const queryIndexRef = useRef<SessionQueryIndex | null>(null);
  const queryIndexGenerationRef = useRef(0);
  const anchorRequestGenerationRef = useRef(0);
  const pendingQueryScrollRef = useRef<string | null>(null);
  const pendingLatestScrollRef = useRef(false);
  const isReturningLatestHistoryRef = useRef(false);
  const historyRefreshSessionRef = useRef<string | null>(null);
  const historyRefreshInFlightRef = useRef(false);
  const historyRefreshPendingRef = useRef(false);
  const seenNativeEventKeysRef = useRef<Set<string>>(new Set());
  const draftSessionRef = useRef<string | null>(null);
  const preserveNativeDraftRef = useRef(false);
  const isLoadingOlderHistoryRef = useRef(false);
  const prependScrollAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const nextAutoScrollRef = useRef<"instant" | "skip" | null>(null);
  const [isLoadingOlderHistory, setIsLoadingOlderHistory] = useState(false);
  const [olderHistoryError, setOlderHistoryError] = useState<string | null>(null);
  const [queryIndex, setQueryIndex] = useState<SessionQueryIndex | null>(null);
  const [historyWindowMode, setHistoryWindowMode] = useState<"latest" | "anchored">("latest");
  const [activeQueryMessageId, setActiveQueryMessageId] = useState<string | null>(null);
  const [loadingQueryMessageId, setLoadingQueryMessageId] = useState<string | null>(null);
  const [hasLatestHistoryUpdates, setHasLatestHistoryUpdates] = useState(false);
  const [isLoadingNewerHistory, setIsLoadingNewerHistory] = useState(false);
  const [isReturningLatestHistory, setIsReturningLatestHistory] = useState(false);
  const [isInitialHistoryLoading, setIsInitialHistoryLoading] = useState(false);
  const [showInitialHistoryLoading, setShowInitialHistoryLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const pickerAnchorRef = useRef<HTMLDivElement>(null);
  const [pickerRect, setPickerRect] = useState<DOMRect | null>(null);
  const [agents, setAgents] = useState<Array<{id: string; name: string; description: string; isActive?: boolean}>>([]);
  const [skills, setSkills] = useState<Array<{name: string; description: string}>>([]);
  /** List of agents selected via @mention — sent in order */
  const [pendingAgents, setPendingAgents] = useState<Array<{id: string; name: string}>>([]);
  const [atQuery, setAtQuery] = useState<string | null>(null);
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const prefetchOlderHistory = useCallback((targetSid: string, cursor: string | null) => {
    const agentApi = window.agentApi;
    if (!cursor || !agentApi) return;
    void historyPrefetchRef.current!
      .prefetch(targetSid, cursor, () => agentApi.getSession(targetSid, {
        before: cursor,
        limit: SESSION_HISTORY_PAGE_SIZE,
      }) as Promise<SessionHistoryDetail | null>)
      .catch((prefetchError) => {
        console.warn("[chat] failed to prefetch older history", {
          sessionId: targetSid,
          error: prefetchError,
        });
      });
  }, []);

  const setHistoryMode = useCallback((mode: "latest" | "anchored") => {
    historyWindowModeRef.current = mode;
    setHistoryWindowMode(mode);
  }, []);

  useEffect(() => {
    if (!isNativeRuntime || !viewSessionId) {
      draftSessionRef.current = null;
      return;
    }
    if (draftSessionRef.current !== viewSessionId) {
      draftSessionRef.current = viewSessionId;
      setInput(readSessionDraft(viewSessionId));
      return;
    }
    if (preserveNativeDraftRef.current && input === "") {
      preserveNativeDraftRef.current = false;
      return;
    }
    writeSessionDraft(viewSessionId, input);
  }, [input, isNativeRuntime, viewSessionId]);

  const handleHistoryScroll = () => {
    const container = messagesScrollRef.current;
    if (!container) return;
    if (container.scrollTop <= 240) loadOlderHistoryRef.current();
    if (
      historyWindowModeRef.current === "anchored"
      && container.scrollHeight - container.scrollTop - container.clientHeight <= 240
    ) {
      loadNewerHistoryRef.current();
    }
    container.classList.add("is-scrolling");
    if (historyScrollTimerRef.current !== null) {
      window.clearTimeout(historyScrollTimerRef.current);
    }
    historyScrollTimerRef.current = window.setTimeout(() => {
      container.classList.remove("is-scrolling");
      historyScrollTimerRef.current = null;
    }, 700);
  };

  useEffect(() => () => {
    if (historyScrollTimerRef.current !== null) {
      window.clearTimeout(historyScrollTimerRef.current);
    }
  }, []);

  useLayoutEffect(() => {
    const anchor = prependScrollAnchorRef.current;
    const container = messagesScrollRef.current;
    if (!anchor || !container) return;
    container.scrollTop = anchor.scrollTop + (container.scrollHeight - anchor.scrollHeight);
    prependScrollAnchorRef.current = null;
  }, [messages]);

  useLayoutEffect(() => {
    const messageId = pendingQueryScrollRef.current;
    const container = messagesScrollRef.current;
    if (!messageId || !container) return;
    const target = Array.from(container.querySelectorAll<HTMLElement>("[data-message-id]"))
      .find((element) => element.dataset.messageId === messageId);
    if (!target) return;
    scrollMessageToCenter(container, target);
    pendingQueryScrollRef.current = null;
    setActiveQueryMessageId(messageId);
  }, [messages]);

  useLayoutEffect(() => {
    const container = messagesScrollRef.current;
    if (!pendingLatestScrollRef.current || !container || historyWindowMode !== "latest") return;
    pendingLatestScrollRef.current = false;
    container.scrollTop = container.scrollHeight;
  }, [historyWindowMode, messages]);

  // ── Voice: dictation (input) + per-message TTS (output) ────────────────
  const [isRecording, setIsRecording] = useState(false);
  /** ID of the assistant message currently being spoken aloud */
  const [speakingMsgId, setSpeakingMsgId] = useState<string | null>(null);
  const dictationRef = useRef<DictationHandle | null>(null);

  useEffect(() => {
    const api = window.agentApi;
    if (!api?.onTtsStart || !api.onTtsPcm || !api.onTtsStreamEnd || !api.onTtsFlush) return;
    const player = new PcmStreamPlayer(api);
    const dispose = [
      api.onTtsStart((metadata) => player.start(metadata)),
      api.onTtsPcm(({ generation, pcm }) => player.enqueue(generation, pcm)),
      api.onTtsStreamEnd(({ generation }) => player.finish(generation)),
      api.onTtsFlush(({ generation }) => player.flush(generation)),
      api.onTtsEnd(() => setSpeakingMsgId(null)),
    ];
    return () => {
      for (const removeListener of dispose) removeListener();
      player.dispose();
    };
  }, []);

  const handleMicToggle = () => {
    if (isRecording) {
      dictationRef.current?.stop();
      dictationRef.current = null;
      setIsRecording(false);
      return;
    }
    void interruptSpeech(window.agentApi, stopSpeaking);
    const prefix = input ? `${input.trimEnd()} ` : "";
    const handle = startDictation({
      onInterim: (text) => setInput(prefix + text),
      onFinal: (text) => {
        setInput(prefix + text);
        inputRef.current?.focus();
      },
      onError: (message) => setError(message),
      onEnd: () => {
        setIsRecording(false);
        dictationRef.current = null;
      },
    });
    if (handle) {
      dictationRef.current = handle;
      setIsRecording(true);
    }
  };

  const handleSpeakMessage = async (msgId: string, content: string) => {
    if (speakingMsgId === msgId) {
      await interruptSpeech(window.agentApi, stopSpeaking);
      setSpeakingMsgId(null);
      return;
    }
    await interruptSpeech(window.agentApi, stopSpeaking);
    if (!window.agentApi?.ttsSpeak) {
      setError("TTS 模型服务不可用");
      return;
    }
    setSpeakingMsgId(msgId);
    try {
      const result = await window.agentApi.ttsSpeak(content);
      if (!result.ok) {
        setSpeakingMsgId(null);
        setError("TTS 模型播报失败");
      }
    } catch (error) {
      setSpeakingMsgId(null);
      setError(error instanceof Error ? error.message : "TTS 模型播报失败");
    }
  };
  // Track which session the current agent run belongs to
  const runningSessionRef = useRef<string | null>(null);
  // Track whether the user aborted the current run (skip queue processing)
  const abortRef = useRef(false);
  // Runs started by this renderer drain their queue in startRun's finally
  // block. Goal runs and refresh-recovered runs need terminal-event draining.
  const managedRunSessionsRef = useRef<Set<string>>(new Set());
  const queuedRunDrainTimersRef = useRef<Map<string, number>>(new Map());
  // A stale browser can try to send while a recovered native run is already
  // active. Keep that original run marked as live when its admission rejects.
  const preserveNativeConflictRef = useRef<Set<string>>(new Set());
  // Always-current refs for selectedSessionId and sessionId — used inside event
  // handlers that are captured in closures and may outlive React renders.
  const selectedSessionIdRef = useRef<string | null>(selectedSessionId ?? null);
  const sessionIdRef = useRef<string | null>(null);
  const sessionLoadGenerationRef = useRef(0);
  useEffect(() => { selectedSessionIdRef.current = selectedSessionId ?? null; }, [selectedSessionId]);
  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);
  useEffect(() => () => {
    for (const timer of queuedRunDrainTimersRef.current.values()) window.clearTimeout(timer);
    queuedRunDrainTimersRef.current.clear();
  }, []);
  const loadGoalState = useCallback(async (targetSessionId?: string | null) => {
    const id = targetSessionId || selectedSessionIdRef.current || sessionIdRef.current;
    if (!id || !window.agentApi?.getSessionGoals) {
      setGoalState({ active: null, queued: [], history: [] });
      return;
    }
    try {
      const state = await window.agentApi.getSessionGoals(id);
      applySessionQueueState(state, id);
      if (state.active) {
        runningSessionRef.current = id;
        setRunningSession(id);
      }
    } catch (goalError) {
      setError(goalError instanceof Error ? goalError.message : "目标状态加载失败");
    }
  }, [applySessionQueueState, setRunningSession]);
  useEffect(() => {
    void loadGoalState(viewSessionId);
  }, [viewSessionId, loadGoalState]);
  const updateAgentActivity = useCallback((next: "idle" | "thinking" | "tools") => {
    const activitySessionId = selectedSessionIdRef.current || sessionIdRef.current;
    if (
      next === "thinking"
      && (agentActivityRef.current !== "thinking" || thinkingSessionIdRef.current !== activitySessionId)
    ) {
      thinkingSessionIdRef.current = activitySessionId;
      setThinkingStartedAt(Date.now());
    } else if (next !== "thinking") {
      thinkingSessionIdRef.current = null;
    }
    agentActivityRef.current = next;
    setAgentActivity(next);
  }, []);
  const beginAgentRunActivity = useCallback((targetSessionId: string) => {
    thinkingSessionIdRef.current = targetSessionId;
    agentActivityRef.current = "thinking";
    setThinkingStartedAt(Date.now());
    setAgentActivity("thinking");
  }, []);
  useEffect(() => {
    setSessionError(undefined);
    setOccupiedDraft(undefined);
    setIsForkingSession(false);
    setPreviewedMessageImage(null);
  }, [selectedSessionId]);

  /** Parse an interval string like "5m", "30s", "2h", "1min" into milliseconds. Returns null if unrecognized. */
  const parseInterval = (raw: string): number | null => {
    const m = raw.match(/^(\d+(?:\.\d+)?)(s|sec|秒|m|min|分钟|h|hr|hour|小时)$/i);
    if (!m) return null;
    const n = parseFloat(m[1]);
    const unit = m[2].toLowerCase();
    if (unit === "s" || unit === "sec" || unit === "秒") return Math.round(n * 1000);
    if (unit === "m" || unit === "min" || unit === "分钟") return Math.round(n * 60_000);
    if (unit === "h" || unit === "hr" || unit === "hour" || unit === "小时") return Math.round(n * 3_600_000);
    return null;
  };

  /** Format milliseconds into a human-readable string */
  const formatInterval = (ms: number): string => {
    if (ms >= 3_600_000 && ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
    if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000}min`;
    return `${ms / 1000}s`;
  };

  useEffect(() => {
    if (!window.agentApi) return;
    void window.agentApi.listAgentDefs().then((list) => setAgents(list as Array<{id: string; name: string; description: string; isActive?: boolean}>));
    void window.agentApi.listSkills().then((list) => setSkills((list as Array<{name: string; description: string}>).filter(s => s.name))).catch((e: unknown) => console.error('[listSkills] mount error:', e));
  }, []);

  const filteredAgents = atQuery === null ? [] : agents.filter(a =>
    atQuery === "" || a.name.toLowerCase().includes(atQuery.toLowerCase())
  );

  /** Built-in slash commands that always appear in the picker */
  const BUILTIN_COMMANDS = [
    { name: "goal", description: "目标模式：持续推进当前目标，后续目标自动排队" },
    { name: "compact", description: "主动压缩当前会话上下文，并在下轮重新注入环境" },
    { name: "loop", description: "定时任务：/loop 5m 任务 | list | pause/resume/delete <id> | stop" },
  ];

  const filteredSkills = slashQuery === null ? [] : [
    ...BUILTIN_COMMANDS.filter(c => slashQuery === "" || c.name.toLowerCase().includes(slashQuery.toLowerCase())),
    ...skills.filter(s => slashQuery === "" || s.name.toLowerCase().includes(slashQuery.toLowerCase())),
  ];
  if (slashQuery !== null) {
    // debug: console.log('[skill-picker] slashQuery=', slashQuery, 'filtered=', filteredSkills.length);
  }

  const selectAgent = (agent: {id: string; name: string}) => {
    // Add agent to pending list (avoid duplicates)
    setPendingAgents(prev =>
      prev.find(a => a.id === agent.id) ? prev : [...prev, agent]
    );
    setInput(prev => prev.replace(/@[\w\u4e00-\u9fff]*$/, ""));
    setAtQuery(null);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const removePendingAgent = (id: string) => {
    setPendingAgents(prev => prev.filter(a => a.id !== id));
  };

  const selectSkill = (skill: {name: string}) => {
    setInput(prev => prev.replace(/\/[\w\u4e00-\u9fff\-_]*$/, `/${skill.name} `));
    setSlashQuery(null);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const handleComposerChange = (value: string) => {
    setInput(value);
    const atMatch = value.match(/@([\w\u4e00-\u9fff]*)$/);
    if (atMatch) {
      if (window.agentApi) {
        void window.agentApi.listAgentDefs().then((list) =>
          setAgents(list as Array<{id: string; name: string; description: string; isActive?: boolean}>),
        );
      }
      setPickerRect(pickerAnchorRef.current?.getBoundingClientRect() ?? null);
      setAtQuery(atMatch[1]);
      setSlashQuery(null);
      return;
    }
    const slashMatch = value.match(/\/([-\w\u4e00-\u9fff]*)$/);
    if (slashMatch) {
      if (window.agentApi) {
        void window.agentApi.listSkills().then((list) =>
          setSkills((list as Array<{name: string; description: string}>).filter((skill) => skill.name)),
        ).catch((error: unknown) => console.error("[listSkills] slash error:", error));
      }
      setPickerRect(pickerAnchorRef.current?.getBoundingClientRect() ?? null);
      setSlashQuery(slashMatch[1]);
      setAtQuery(null);
      return;
    }
    setAtQuery(null);
    setSlashQuery(null);
  };

  const selectStarterPrompt = (prompt: string) => {
    handleComposerChange(prompt);
    setAtQuery(null);
    setSlashQuery(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const handleComposerKeyDown = (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.key === "Escape" && (atQuery !== null || slashQuery !== null)) {
      event.preventDefault();
      setAtQuery(null);
      setSlashQuery(null);
    } else if (event.key === "Escape" && isLocallyRunning) {
      event.preventDefault();
      handleAbort();
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void handleSend();
    }
  };

  const handleFileAttach = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;

    const imageCount = files.filter((file) => file.type.toLowerCase().startsWith("image/")).length;
    if (imageCount > 0) setPendingImageReads((count) => count + 1);
    try {
      const prepared = await prepareComposerFiles(files, async (file) => (
        blobToDataUrl(await normalizeComposerImage(file))
      ));
      if (prepared.attachments.length > 0) {
        setAttachedFiles((previous) => [...previous, ...prepared.attachments]);
      }
      if (prepared.images.length > 0) {
        setPendingImages((previous) => [...previous, ...prepared.images]);
        if (!isNativeRuntime) autoSwitchVisionProfile();
      }
      const failed = [...prepared.unsupportedImages, ...prepared.failedImages];
      if (failed.length > 0) {
        setError(`无法添加图片：${failed.map((file) => file.name).join("、")}。仅支持 JPG、PNG、GIF 和 WebP。`);
      }
    } finally {
      if (imageCount > 0) setPendingImageReads((count) => Math.max(0, count - 1));
    }
  };

  const removeAttachedFile = (index: number) => {
    setAttachedFiles((prev) => prev.filter((_, i) => i !== index));
  };

  // ── Vision / image helpers ─────────────────────────────────────────────
  const VISION_MODEL_RE = /claude-3|gpt-4-vision|gpt-4o|gpt-4-turbo|gemini|deepseek-vl/i;
  const isVisionModel = (modelId: string) => VISION_MODEL_RE.test(modelId);

  /** Auto-switch to a vision-capable profile when images are added */
  const autoSwitchVisionProfile = () => {
    const currentProfile = profiles.find((p) => p.id === activeProfileId);
    if (currentProfile && isVisionModel(currentProfile.modelId)) return;
    const visionProfile = profiles.find((p) => isVisionModel(p.modelId));
    if (visionProfile) switchActiveProfile(visionProfile.id);
  };

  /** Add a base64 data URL to the pending image list */
  const addPendingImage = (dataUrl: string) => {
    setPendingImages((prev) => [...prev, dataUrl]);
  };

  const removePendingImage = (index: number) => {
    setPendingImages((prev) => prev.filter((_, i) => i !== index));
  };

  /** Read an image Blob and add it as a base64 data URL */
  const blobToDataUrl = (blob: Blob): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });

  // Global paste handler: intercept image pastes into the chat input
  useEffect(() => {
    const handlePaste = async (e: ClipboardEvent) => {
      if (!e.clipboardData) return;
      const imageItem = Array.from(e.clipboardData.items).find((it) => it.type.startsWith("image/"));
      if (!imageItem) return;
      e.preventDefault();
      const file = imageItem.getAsFile();
      if (!file) return;
      setPendingImageReads((count) => count + 1);
      try {
        addPendingImage(await blobToDataUrl(await normalizeComposerImage(file)));
      } catch {
        setError("无法添加图片。仅支持 JPG、PNG、GIF 和 WebP。");
      } finally {
        setPendingImageReads((count) => Math.max(0, count - 1));
      }
    };
    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profiles, activeProfileId]);

  useEffect(() => {
    const mode = nextAutoScrollRef.current;
    nextAutoScrollRef.current = null;
    if (mode === "skip") return;
    messagesEndRef.current?.scrollIntoView({ behavior: mode === "instant" ? "auto" : "smooth" });
  }, [messages]);

  // Global event listener — receives both user-initiated and cron-fired events.
  // handleEvent filters by _sid so only events for the current session are shown.
  useEffect(() => {
    if (!window.agentApi) return;
    const unsub = window.agentApi.onEvent((event) => handleEvent(event as StreamEvent));
    return unsub;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    const loadGeneration = ++sessionLoadGenerationRef.current;
    const targetSid = selectedSessionId;
    let slowLoadingTimer: number | null = null;
    const isCurrentLoad = () => (
      sessionLoadGenerationRef.current === loadGeneration
      && selectedSessionIdRef.current === targetSid
    );

    const loadSelectedSession = async () => {
      const agentApi = window.agentApi;
      if (!agentApi) return;
      // Capture at call time — used to detect stale responses from fast session switching.
      if (shouldSkipVoiceSessionReload(runningSessionRef.current, sessionIdRef.current, targetSid)) return;
      if (!targetSid) {
        if (!isCurrentLoad()) return;
        historyPrefetchRef.current?.invalidate();
        clearMessages();
        setError(null);
        setSessionLoadError(null);
        setDirectCompatibilitySessionId(null);
        setCompatibilityFailure(null);
        historyCursorRef.current = null;
        latestHistoryCursorRef.current = null;
        anchoredNewerCursorRef.current = null;
        queryIndexGenerationRef.current += 1;
        queryIndexRef.current = null;
        setQueryIndex(null);
        setHistoryMode("latest");
        setActiveQueryMessageId(null);
        setLoadingQueryMessageId(null);
        isReturningLatestHistoryRef.current = false;
        setIsReturningLatestHistory(false);
        setHasLatestHistoryUpdates(false);
        setOlderHistoryError(null);
        setIsInitialHistoryLoading(false);
        setShowInitialHistoryLoading(false);
        historySessionIdRef.current = null;
        sessionIdRef.current = null;
        setSessionId("");
        setPermissionMode("full-access");
        return;
      }
      // Don't reload from DB while agent is streaming FOR THIS SESSION — messages are in-memory.
      // But only skip if the store already has this session loaded; if the user navigated away
      // and back, sessionId won't match and we must reload.

      setError(null);
      setSessionLoadError(null);
      setDirectCompatibilitySessionId(null);
      setCompatibilityFailure(null);
      setOlderHistoryError(null);
      historyPrefetchRef.current?.invalidate();
      anchorRequestGenerationRef.current += 1;
      historyCursorRef.current = null;
      latestHistoryCursorRef.current = null;
      anchoredNewerCursorRef.current = null;
      setHistoryMode("latest");
      setHasLatestHistoryUpdates(false);
      setActiveQueryMessageId(null);
      setLoadingQueryMessageId(null);
      isReturningLatestHistoryRef.current = false;
      setIsReturningLatestHistory(false);
      if (queryIndexRef.current?.sessionId !== targetSid) {
        queryIndexGenerationRef.current += 1;
        queryIndexRef.current = null;
        setQueryIndex(null);
      }
      setIsInitialHistoryLoading(true);
      setShowInitialHistoryLoading(false);
      historySessionIdRef.current = targetSid;
      sessionIdRef.current = targetSid;
      setSessionId(targetSid);
      const cachedMessages = getMessagesForSession(targetSid);
      setMessages(cachedMessages, targetSid);
      slowLoadingTimer = window.setTimeout(() => {
        if (isCurrentLoad()) setShowInitialHistoryLoading(true);
      }, 500);
      try {
        const detail = await loadSessionWithRetry(async () => {
          if (!isCurrentLoad()) throw new DOMException("Session selection changed", "AbortError");
          return agentApi.getSession(targetSid, {
            limit: SESSION_HISTORY_PAGE_SIZE,
          }) as Promise<SessionHistoryDetail | null>;
        });
        const permissionDetail = detail as (SessionHistoryDetail & {
          permissionMode?: unknown;
          metadata?: Record<string, unknown>;
        }) | null;
        const restoredContextUsage = findLatestContextUsage(detail?.events ?? []);
        const restoredRuntimeProgress = reduceRuntimeProgressEvents((detail?.events ?? []) as AgentEvent[]);
        const restoredNativeSubagents = reduceNativeSubagentActivities((detail?.events ?? []) as AgentEvent[]);
        const restored = restoreSessionHistoryPage(detail);
        if (!isCurrentLoad()) return;
        if (sessionSummary?.compatibility) setDirectCompatibilitySessionId(targetSid);
        setPermissionMode(normalizePermissionMode(
          permissionDetail?.permissionMode ?? permissionDetail?.metadata?.permissionMode,
        ));
        const nextCursor = detail?.history?.nextCursor ?? null;
        historyCursorRef.current = nextCursor;
        latestHistoryCursorRef.current = nextCursor;
        anchoredNewerCursorRef.current = null;
        const liveMessages = getMessagesForSession(targetSid);
        const preferLive = liveMessages.length > 0
          && useAgentStore.getState().runningSessionId === targetSid;
        const baseMessages = preferLive ? liveMessages : restored;
        const nextMessages = detail?.goalState && targetSid.startsWith("runtime:")
          ? reconcileDurableQueuedMessages(baseMessages, detail.goalState)
          : baseMessages;
        nextAutoScrollRef.current = "instant";
        setMessages(nextMessages, targetSid);
        prefetchOlderHistory(targetSid, nextCursor);
        setRuntimeProgress(restoredRuntimeProgress, targetSid);
        setNativeSubagentActivities(restoredNativeSubagents, targetSid);
        // Native runs can outlive a browser refresh. Rehydrate their running
        // state from the broker detail so the composer queues a follow-up
        // instead of sending a second concurrent turn against the same lock.
        if (shouldRestoreLocalNativeRun(detail)) {
          runningSessionRef.current = targetSid;
          setRunningSession(targetSid);
        } else if (runningSessionRef.current === targetSid) {
          runningSessionRef.current = null;
          setRunningSession(null);
        }
        if (restoredContextUsage) setContextUsage(restoredContextUsage, targetSid);

        // Infer agent activity phase from restored messages. Tool rows render
        // their own running spinner, so this phase suppresses the text indicator.
        const lastMsg = nextMessages[nextMessages.length - 1];
        if (lastMsg?.role === "assistant" && lastMsg.toolCalls?.length) {
          const allDone = areToolCallsComplete(lastMsg.toolCalls);
          updateAgentActivity(allDone ? "thinking" : "tools");
        } else {
          updateAgentActivity(detail?.agentType !== "customer-agent" && detail?.status === "running"
            ? "thinking"
            : "idle");
        }
      } catch (error) {
        if (!isCurrentLoad()) return;
        console.error("[chat] failed to restore session", { sessionId: targetSid, error });
        const reason = describeSessionLoadError(error);
        setSessionLoadError(reason);
        if (sessionSummary?.compatibility) setCompatibilityFailure(reason);
      } finally {
        if (slowLoadingTimer !== null) window.clearTimeout(slowLoadingTimer);
        if (isCurrentLoad()) {
          setIsInitialHistoryLoading(false);
          setShowInitialHistoryLoading(false);
        }
      }
    };

    void loadSelectedSession();
    return () => {
      if (slowLoadingTimer !== null) window.clearTimeout(slowLoadingTimer);
      if (sessionLoadGenerationRef.current === loadGeneration) {
        sessionLoadGenerationRef.current += 1;
      }
    };
  }, [clearMessages, getMessagesForSession, prefetchOlderHistory, selectedSessionId, sessionReloadGeneration, setContextUsage, setHistoryMode, setMessages, setSessionId, updateAgentActivity]);

  const loadSessionQueryIndex = useCallback(async (targetSid: string) => {
    const agentApi = window.agentApi;
    if (!agentApi?.getSessionQueryIndex) return null;
    const generation = ++queryIndexGenerationRef.current;
    try {
      const loaded = await agentApi.getSessionQueryIndex(targetSid);
      if (
        queryIndexGenerationRef.current !== generation
        || selectedSessionIdRef.current !== targetSid
        || loaded.sessionId !== targetSid
      ) return null;
      queryIndexRef.current = loaded;
      setQueryIndex(loaded);
      return loaded;
    } catch (indexError) {
      if (queryIndexGenerationRef.current === generation) {
        console.warn("[chat] failed to load query index", { sessionId: targetSid, error: indexError });
      }
      return null;
    }
  }, []);

  useEffect(() => {
    const targetSid = selectedSessionId;
    if (!targetSid || isInitialHistoryLoading || !window.agentApi?.getSessionQueryIndex) return;
    let cancelled = false;
    const run = () => {
      if (!cancelled && selectedSessionIdRef.current === targetSid) {
        void loadSessionQueryIndex(targetSid);
      }
    };
    const host = window as typeof window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    const handle = host.requestIdleCallback
      ? host.requestIdleCallback(run, { timeout: 1_000 })
      : window.setTimeout(run, 0);
    return () => {
      cancelled = true;
      if (host.cancelIdleCallback && host.requestIdleCallback) host.cancelIdleCallback(handle);
      else window.clearTimeout(handle);
    };
  }, [isInitialHistoryLoading, loadSessionQueryIndex, selectedSessionId, sessionReloadGeneration]);

  const refreshLatestHistory = useCallback(async (targetSid: string) => {
    if (!window.agentApi || document.visibilityState === "hidden") return;
    if (historyWindowModeRef.current === "anchored") {
      setHasLatestHistoryUpdates(true);
      return;
    }
    if (historyRefreshSessionRef.current !== targetSid) {
      historyRefreshSessionRef.current = targetSid;
      historyRefreshInFlightRef.current = false;
      historyRefreshPendingRef.current = false;
    }
    if (historyRefreshInFlightRef.current) {
      historyRefreshPendingRef.current = true;
      return;
    }

    historyRefreshInFlightRef.current = true;
    try {
      do {
        historyRefreshPendingRef.current = false;
        const detail = await window.agentApi.getSession(targetSid, {
          limit: SESSION_HISTORY_PAGE_SIZE,
        }) as SessionHistoryDetail | null;
        if (
          selectedSessionIdRef.current !== targetSid
          || historySessionIdRef.current !== targetSid
        ) return;

        const refreshed = restoreSessionHistoryPage(detail);
        const current = getMessagesForSession(targetSid);
        const mergedHistory = mergeRefreshedSessionHistory(current, refreshed);
        const merged = detail?.goalState && targetSid.startsWith("runtime:")
          ? reconcileDurableQueuedMessages(mergedHistory, detail.goalState)
          : mergedHistory;
        const container = messagesScrollRef.current;
        const isNearBottom = !container
          || container.scrollHeight - container.scrollTop - container.clientHeight < 80;
        nextAutoScrollRef.current = isNearBottom ? null : "skip";
        setMessages(merged, targetSid);
        if (detail?.goalState) setGoalState(projectSessionGoals(detail.goalState) as SessionGoalState);

        const previousLatestCursor = latestHistoryCursorRef.current;
        const nextLatestCursor = detail?.history?.nextCursor ?? null;
        if (historyCursorRef.current === previousLatestCursor) {
          const cursorChanged = historyCursorRef.current !== nextLatestCursor;
          historyCursorRef.current = nextLatestCursor;
          if (cursorChanged) {
            historyPrefetchRef.current?.invalidate();
            prefetchOlderHistory(targetSid, nextLatestCursor);
          }
        }
        latestHistoryCursorRef.current = nextLatestCursor;
        if (
          detail?.history?.revision
          && detail.history.revision !== queryIndexRef.current?.revision
        ) {
          void loadSessionQueryIndex(targetSid);
        }
        const restoredContextUsage = findLatestContextUsage(detail?.events ?? []);
        setRuntimeProgress(reduceRuntimeProgressEvents((detail?.events ?? []) as AgentEvent[]), targetSid);
        setNativeSubagentActivities(
          reduceNativeSubagentActivities((detail?.events ?? []) as AgentEvent[]),
          targetSid,
        );
        if (restoredContextUsage) setContextUsage(restoredContextUsage, targetSid);

        const lastMessage = merged[merged.length - 1];
        if (lastMessage?.role === "assistant" && lastMessage.toolCalls?.length) {
          updateAgentActivity(areToolCallsComplete(lastMessage.toolCalls) ? "thinking" : "tools");
        } else {
          updateAgentActivity(isActiveNativeSession(detail) ? "thinking" : "idle");
        }
      } while (historyRefreshPendingRef.current);
    } catch (refreshError) {
      console.error("[chat] failed to refresh native session history", {
        sessionId: targetSid,
        error: refreshError,
      });
    } finally {
      if (historyRefreshSessionRef.current === targetSid) {
        historyRefreshInFlightRef.current = false;
      }
    }
  }, [getMessagesForSession, loadSessionQueryIndex, prefetchOlderHistory, setContextUsage, setMessages, updateAgentActivity]);

  useEffect(() => {
    const targetSid = selectedSessionId;
    const shouldFollow = shouldFollowNativeHistory(sessionSummary, targetSid, runningSessionId);
    const shouldPollFallback = sessionSummary?.occupancy === "owned-externally"
      || sessionSummary?.status === "running";
    if (!targetSid || !shouldFollow || !window.agentApi) return;

    let stopObserver: (() => void) | null = null;
    let pollingTimer: number | null = null;
    let disposed = false;

    const refresh = () => {
      if (!disposed && document.visibilityState !== "hidden") {
        void refreshLatestHistory(targetSid);
      }
    };
    const stopTransport = () => {
      stopObserver?.();
      stopObserver = null;
      if (pollingTimer !== null) window.clearInterval(pollingTimer);
      pollingTimer = null;
    };
    const startPolling = () => {
      if (disposed || pollingTimer !== null || document.visibilityState === "hidden") return;
      refresh();
      pollingTimer = window.setInterval(refresh, 2_000);
    };
    const startTransport = () => {
      if (disposed || document.visibilityState === "hidden") return;
      if (typeof window.agentApi.observeSession !== "function") {
        if (shouldPollFallback) startPolling();
        return;
      }
      try {
        stopObserver = window.agentApi.observeSession(targetSid, refresh, () => {
          stopObserver = null;
          if (shouldPollFallback) startPolling();
        });
      } catch {
        if (shouldPollFallback) startPolling();
      }
    };
    const handleVisibilityChange = () => {
      stopTransport();
      if (document.visibilityState !== "hidden") {
        refresh();
        startTransport();
      }
    };

    startTransport();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      stopTransport();
      if (historyRefreshSessionRef.current === targetSid) {
        historyRefreshSessionRef.current = null;
        historyRefreshPendingRef.current = false;
      }
    };
  }, [
    refreshLatestHistory,
    selectedSessionId,
    runningSessionId,
    sessionSummary?.agentType,
    sessionSummary?.occupancy,
    sessionSummary?.status,
  ]);

  const loadOlderHistory = useCallback(async () => {
    const targetSid = historySessionIdRef.current;
    const cursor = historyCursorRef.current;
    const agentApi = window.agentApi;
    if (!agentApi || !targetSid || !cursor || isLoadingOlderHistoryRef.current) return;

    isLoadingOlderHistoryRef.current = true;
    setOlderHistoryError(null);
    const slowLoadingTimer = window.setTimeout(() => {
      if (historySessionIdRef.current === targetSid && isLoadingOlderHistoryRef.current) {
        setIsLoadingOlderHistory(true);
      }
    }, 500);
    try {
      const detail = await historyPrefetchRef.current!.consume(
        targetSid,
        cursor,
        () => agentApi.getSession(targetSid, {
          before: cursor,
          limit: SESSION_HISTORY_PAGE_SIZE,
        }) as Promise<SessionHistoryDetail | null>,
      );
      if (historySessionIdRef.current !== targetSid || selectedSessionIdRef.current !== targetSid) return;

      const olderMessages = restoreSessionHistoryPage(detail);
      const currentMessages = getMessagesForSession(targetSid);
      const container = messagesScrollRef.current;
      if (container && olderMessages.length > 0) {
        prependScrollAnchorRef.current = {
          scrollHeight: container.scrollHeight,
          scrollTop: container.scrollTop,
        };
        nextAutoScrollRef.current = "skip";
      }
      const nextCursor = detail?.history?.nextCursor ?? null;
      historyCursorRef.current = nextCursor;
      if (olderMessages.length > 0) {
        setMessages([...olderMessages, ...currentMessages], targetSid);
      }
      prefetchOlderHistory(targetSid, nextCursor);
    } catch (loadError) {
      if (historySessionIdRef.current !== targetSid) return;
      console.error("[chat] failed to load older history", { sessionId: targetSid, error: loadError });
      setOlderHistoryError(loadError instanceof Error ? loadError.message : "历史消息加载失败");
    } finally {
      window.clearTimeout(slowLoadingTimer);
      isLoadingOlderHistoryRef.current = false;
      if (historySessionIdRef.current === targetSid) setIsLoadingOlderHistory(false);
    }
  }, [getMessagesForSession, prefetchOlderHistory, setMessages]);

  useEffect(() => {
    loadOlderHistoryRef.current = () => { void loadOlderHistory(); };
  }, [loadOlderHistory]);

  const loadNewerHistory = useCallback(async () => {
    const targetSid = historySessionIdRef.current;
    const cursor = anchoredNewerCursorRef.current;
    if (
      !window.agentApi
      || !targetSid
      || !cursor
      || historyWindowModeRef.current !== "anchored"
      || isLoadingNewerHistoryRef.current
    ) return;

    isLoadingNewerHistoryRef.current = true;
    setIsLoadingNewerHistory(true);
    try {
      const detail = await window.agentApi.getSession(targetSid, {
        after: cursor,
        limit: SESSION_HISTORY_PAGE_SIZE,
      }) as SessionHistoryDetail | null;
      if (
        selectedSessionIdRef.current !== targetSid
        || historySessionIdRef.current !== targetSid
        || historyWindowModeRef.current !== "anchored"
      ) return;
      const current = getMessagesForSession(targetSid);
      const existingIds = new Set(current.map((message) => message.id));
      const newer = restoreSessionHistoryPage(detail).filter((message) => !existingIds.has(message.id));
      anchoredNewerCursorRef.current = detail?.history?.newerCursor ?? null;
      if (newer.length > 0) {
        nextAutoScrollRef.current = "skip";
        setMessages([...current, ...newer], targetSid);
      }
    } catch (loadError) {
      console.error("[chat] failed to load newer anchored history", {
        sessionId: targetSid,
        error: loadError,
      });
    } finally {
      isLoadingNewerHistoryRef.current = false;
      setIsLoadingNewerHistory(false);
    }
  }, [getMessagesForSession, setMessages]);

  useEffect(() => {
    loadNewerHistoryRef.current = () => { void loadNewerHistory(); };
  }, [loadNewerHistory]);

  const returnToLatestHistory = useCallback(async () => {
    const targetSid = selectedSessionIdRef.current;
    if (!window.agentApi || !targetSid || isReturningLatestHistoryRef.current) return false;
    const requestGeneration = ++anchorRequestGenerationRef.current;
    isReturningLatestHistoryRef.current = true;
    setIsReturningLatestHistory(true);
    setLoadingQueryMessageId(null);
    try {
      const detail = await window.agentApi.getSession(targetSid, {
        limit: SESSION_HISTORY_PAGE_SIZE,
      }) as SessionHistoryDetail | null;
      if (
        anchorRequestGenerationRef.current !== requestGeneration
        || selectedSessionIdRef.current !== targetSid
      ) return false;
      const restored = restoreSessionHistoryPage(detail);
      const cursor = detail?.history?.nextCursor ?? null;
      historyPrefetchRef.current?.invalidate();
      historyCursorRef.current = cursor;
      latestHistoryCursorRef.current = cursor;
      anchoredNewerCursorRef.current = null;
      setHistoryMode("latest");
      setHasLatestHistoryUpdates(false);
      setActiveQueryMessageId(queryIndexRef.current?.entries.at(-1)?.messageId ?? null);
      pendingLatestScrollRef.current = true;
      nextAutoScrollRef.current = "skip";
      setMessages(restored, targetSid);
      prefetchOlderHistory(targetSid, cursor);
      if (detail?.history?.revision !== queryIndexRef.current?.revision) {
        void loadSessionQueryIndex(targetSid);
      }
      return true;
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "返回最新消息失败");
      return false;
    } finally {
      isReturningLatestHistoryRef.current = false;
      setIsReturningLatestHistory(false);
    }
  }, [loadSessionQueryIndex, prefetchOlderHistory, setHistoryMode, setMessages]);

  const activateQuery = useCallback(async (
    entry: SessionQueryIndexEntry,
    retryOnStale = true,
  ): Promise<void> => {
    const targetSid = selectedSessionIdRef.current;
    const container = messagesScrollRef.current;
    if (!window.agentApi || !targetSid || !container) return;
    const requestGeneration = ++anchorRequestGenerationRef.current;
    setActiveQueryMessageId(entry.messageId);
    const rendered = Array.from(container.querySelectorAll<HTMLElement>("[data-message-id]"))
      .find((element) => element.dataset.messageId === entry.messageId);
    if (rendered) {
      setLoadingQueryMessageId(null);
      scrollMessageToCenter(container, rendered, "smooth");
      return;
    }

    setLoadingQueryMessageId(entry.messageId);
    historyPrefetchRef.current?.invalidate();
    try {
      const detail = await window.agentApi.getSession(targetSid, {
        anchor: entry.pageToken,
        limit: SESSION_HISTORY_PAGE_SIZE,
      }) as SessionHistoryDetail | null;
      if (
        anchorRequestGenerationRef.current !== requestGeneration
        || selectedSessionIdRef.current !== targetSid
        || queryIndexRef.current?.revision !== detail?.history?.revision
      ) return;
      const restored = restoreSessionHistoryPage(detail);
      const olderCursor = detail?.history?.olderCursor ?? detail?.history?.nextCursor ?? null;
      historyCursorRef.current = olderCursor;
      anchoredNewerCursorRef.current = detail?.history?.newerCursor ?? null;
      setHistoryMode("anchored");
      setHasLatestHistoryUpdates(false);
      pendingQueryScrollRef.current = entry.messageId;
      nextAutoScrollRef.current = "skip";
      setMessages(restored, targetSid);
      window.requestAnimationFrame(() => {
        if (
          anchorRequestGenerationRef.current !== requestGeneration
          || selectedSessionIdRef.current !== targetSid
        ) return;
        const currentContainer = messagesScrollRef.current;
        const target = Array.from(currentContainer?.querySelectorAll<HTMLElement>("[data-message-id]") ?? [])
          .find((element) => element.dataset.messageId === entry.messageId);
        if (!currentContainer || !target) return;
        scrollMessageToCenter(currentContainer, target);
        pendingQueryScrollRef.current = null;
        setActiveQueryMessageId(entry.messageId);
      });
      prefetchOlderHistory(targetSid, olderCursor);
    } catch (anchorError) {
      const stale = (anchorError as { code?: string }).code === "STALE_SESSION_ANCHOR";
      if (stale && retryOnStale) {
        const refreshed = await loadSessionQueryIndex(targetSid);
        const replacement = refreshed?.entries.find((candidate) => candidate.ordinal === entry.ordinal);
        if (replacement) await activateQuery(replacement, false);
        return;
      }
      console.error("[chat] failed to open indexed query", { sessionId: targetSid, error: anchorError });
      setError(anchorError instanceof Error ? anchorError.message : "无法打开这条消息");
    } finally {
      if (anchorRequestGenerationRef.current === requestGeneration) {
        setLoadingQueryMessageId(null);
      }
    }
  }, [loadSessionQueryIndex, prefetchOlderHistory, setHistoryMode, setMessages]);

  const scheduleQueuedMessageAfterTerminal = (targetSessionId: string) => {
    if (
      managedRunSessionsRef.current.has(targetSessionId)
      || queuedRunDrainTimersRef.current.has(targetSessionId)
    ) return;

    const timer = window.setTimeout(() => {
      queuedRunDrainTimersRef.current.delete(targetSessionId);
      void (async () => {
        if (managedRunSessionsRef.current.has(targetSessionId)) return;
        try {
          const state = await window.agentApi?.getSessionGoals(targetSessionId);
          const viewedSid = selectedSessionIdRef.current || sessionIdRef.current;
          if (state && targetSessionId === viewedSid) applySessionQueueState(state, targetSessionId);
          // The native goal coordinator may already have promoted and started
          // another goal. Ordinary queued chat must wait for that queue to end.
          if (state?.active) {
            runningSessionRef.current = targetSessionId;
            if (targetSessionId === viewedSid) {
              abortRef.current = false;
              setError(null);
              setRunningSession(targetSessionId);
            }
            return;
          }

          if (abortRef.current) return;

          const nextQueued = useAgentStore.getState()
            .getMessagesForSession(targetSessionId)
            .find((message) => message.isQueued && !message.queueItemId);
          if (!nextQueued) {
            if (targetSessionId === viewedSid) {
              runningSessionRef.current = null;
              setRunningSession(null);
            }
            return;
          }
          updateMessage(nextQueued.id, (message) => ({ ...message, isQueued: false }), targetSessionId);
          void startRun(nextQueued, targetSessionId);
        } catch (queueError) {
          setError(queueError instanceof Error ? queueError.message : "排队消息自动发送失败");
        }
      })();
    }, 150);
    queuedRunDrainTimersRef.current.set(targetSessionId, timer);
  };

  const handleEvent = (event: StreamEvent) => {
    // Route by _sid using always-current refs, not stale closure values.
    const viewedSid = selectedSessionIdRef.current || sessionIdRef.current;
    const eventSid = event._sid || viewedSid || undefined;
    if (event._nativeRunId && Number.isSafeInteger(event._nativeSequence)) {
      const key = `${event._nativeRunId}:${event._nativeSequence}`;
      if (seenNativeEventKeysRef.current.has(key)) return;
      seenNativeEventKeysRef.current.add(key);
      if (seenNativeEventKeysRef.current.size > 2_000) {
        seenNativeEventKeysRef.current = new Set([...seenNativeEventKeysRef.current].slice(-1_000));
      }
    }
    const isViewed = !eventSid || eventSid === viewedSid;
    if (isViewed && historyWindowModeRef.current === "anchored") {
      setHasLatestHistoryUpdates(true);
      return;
    }
    switch (event.type) {
      case "run_admitted":
        if (eventSid && eventSid === viewedSid) clearSessionDraft(eventSid);
        break;
      case "context_usage":
        if (event.usage) setContextUsage(event.usage, eventSid);
        break;
      case "text_chunk":
        if (event.text) {
          appendText(event.text, eventSid);
          if (isViewed) {
            updateAgentActivity("thinking");
          }
        }
        break;
      case "reasoning_summary_delta":
        if (
          typeof event.itemId === "string"
          && Number.isSafeInteger(event.sectionIndex)
          && typeof event.delta === "string"
        ) {
          applyReasoningSummary({
            type: "reasoning_summary_delta",
            itemId: event.itemId,
            sectionIndex: event.sectionIndex!,
            delta: event.delta,
          }, eventSid);
          if (isViewed) updateAgentActivity("thinking");
        }
        break;
      case "runtime_progress":
        if (
          typeof event.progressId === "string"
          && typeof event.label === "string"
          && ["thinking", "tool", "retry", "status"].includes(event.phase ?? "")
        ) {
          const progress: RuntimeProgress = {
            progressId: event.progressId,
            phase: event.phase!,
            label: event.label,
            ...(event.detail === undefined ? {} : { detail: event.detail }),
            ...(event.toolCallId === undefined ? {} : { toolCallId: event.toolCallId }),
            ...(event.elapsedSeconds === undefined ? {} : { elapsedSeconds: event.elapsedSeconds }),
            ...(event.current === undefined ? {} : { current: event.current }),
            ...(event.total === undefined ? {} : { total: event.total }),
          };
          applyRuntimeProgress(progress, eventSid);
          if (isViewed) updateAgentActivity(progress.phase === "tool" ? "tools" : "thinking");
        }
        break;
      case "native_subagent_update":
        if (event.activity?.parentToolCallId) {
          applyNativeSubagentActivity(event.activity, eventSid);
          if (isViewed && event.activity.status === "running") updateAgentActivity("tools");
        }
        break;
      case "tool_call":
        if (isViewed) {
          updateAgentActivity("tools");
        }
        // dispatch_agent is handled by the subsequent "agent_dispatch" event which
        // carries the subSessionId; skip it here to avoid showing two cards.
        // ask_user is handled by the subsequent "ask_user" event with its own card.
        // show_widget is handled by the subsequent "show_widget" event with its own card.
        if (event.toolCall && event.toolCall.name !== "dispatch_agent" && event.toolCall.name !== "ask_user" && event.toolCall.name !== "show_widget") {
          addMessage({
            id: crypto.randomUUID(),
            role: "assistant",
            content: "",
            toolCalls: [{
              id: event.toolCall.id,
              name: event.toolCall.name,
              arguments: event.toolCall.arguments,
            }],
            timestamp: Date.now(),
          }, eventSid);
        }
        break;
      case "tool_result":
        if (event.result) {
          updateToolResult(event.result.toolCallId, event.result.content, event.result.isError, eventSid);
        }
        break;
      case "todo_update":
        if (event.todos) setTodos(event.todos);
        break;
      case "cron_update":
        if (event.tasks) setCronTasks(event.tasks as CronTask[]);
        break;
      case "agent_dispatch":
        // Show a system hint that a sub-agent is being dispatched
        addMessage({
          id: crypto.randomUUID(),
          role: "assistant",
          content: "",
          toolCalls: [{
            id: crypto.randomUUID(),
            name: "dispatch_agent",
            arguments: { agentName: event.agentName, task: event.task ?? "", subSessionId: event.subSessionId },
          }],
          timestamp: Date.now(),
        }, eventSid);
        // Notify sidebar to load child sessions for this parent
        if (event.subSessionId) {
          runningSubIdsRef.current.add(event.subSessionId);
          const parentSid = runningSessionRef.current || sessionId;
          if (parentSid && onSubSessionCreated) void onSubSessionCreated(parentSid);
        }
        // Toast notification — sub-session started
        onSubAgentEvent?.({ type: 'started', agentName: event.agentName ?? '', task: event.task ?? '', subSessionId: event.subSessionId });
        break;
      case "agent_done":
        if (event.subSessionId) {
          runningSubIdsRef.current.delete(event.subSessionId);
          updateSubAgentStatus(
            event.subSessionId,
            (event.status as "completed" | "failed") ?? "completed",
            event.status === "failed" ? event.error : event.summary,
            eventSid,
          );
        }
        // Toast notification — sub-session finished or errored
        onSubAgentEvent?.({
          type: (event.status === 'failed' ? 'failed' : 'completed'),
          agentName: event.agentName ?? '',
          task: event.task ?? '',
          subSessionId: event.subSessionId,
        });
        break;
      case "agent_progress":
        if (event.subSessionId && event.text) {
          updateSubAgentProgress(event.subSessionId, event.text, eventSid);
        }
        break;
      case "compacted":
        addMessage({
          id: crypto.randomUUID(),
          role: "assistant",
          content: event.summary ?? "",
          isCompactionSummary: true,
          timestamp: Date.now(),
        }, eventSid);
        break;
      case "show_widget": {
        // AgentEvent uses "data" but StreamEvent interface uses "widgetData";
        // IPC forwards the raw AgentEvent, so read from both for safety.
        const widgetData = (event as any).data ?? event.widgetData;
        const widgetMsg = {
          widgetId: event.widgetId!,
          widgetType: event.widgetType!,
          data: widgetData ?? {},
        };
        // If update_id matches an existing message's widget, update it
        const sessionMessages = eventSid ? useAgentStore.getState().getMessagesForSession(eventSid) : useAgentStore.getState().messages;
        const existingMsg = sessionMessages.find((m) => m.widget?.widgetId === widgetMsg.widgetId);
        if (existingMsg) {
          updateMessage(existingMsg.id, (m) => ({
            ...m,
            widget: widgetMsg,
          }), eventSid);
        } else {
          addMessage({
            id: crypto.randomUUID(),
            role: "assistant",
            content: "",
            widget: widgetMsg,
            timestamp: Date.now(),
          }, eventSid);
        }
        break;
      }
      case "ask_user":
        if (event.questionId) {
          const sessionMessages = eventSid
            ? useAgentStore.getState().getMessagesForSession(eventSid)
            : useAgentStore.getState().messages;
          if (sessionMessages.some((message) => message.askUser?.questionId === event.questionId)) break;
        }
        addMessage({
          id: crypto.randomUUID(),
          role: "assistant",
          content: "",
          askUser: {
            questionId: event.questionId ?? "",
            question: event.question ?? "",
            options: event.options,
            fields: event.fields,
            multiSelect: event.multiSelect,
          },
          timestamp: Date.now(),
        }, eventSid);
        break;
      case "approval_resolved": {
        if (!event.questionId) break;
        const sessionMessages = eventSid
          ? useAgentStore.getState().getMessagesForSession(eventSid)
          : useAgentStore.getState().messages;
        const pending = sessionMessages.find((message) => message.askUser?.questionId === event.questionId);
        if (pending) {
          updateMessage(pending.id, (message) => ({
            ...message,
            askUser: message.askUser
              ? { ...message.askUser, answered: true, answer: "已处理" }
              : message.askUser,
          }), eventSid);
        }
        break;
      }
      case "text_done": break;
      case "thinking":
        if (isViewed) {
          updateAgentActivity("thinking");
        }
        break;
      case "done":
        if (eventSid) {
          const durationMs = validCompletionDurationMs(event.durationMs);
          if (durationMs !== undefined) {
            const completedMessage = [...getMessagesForSession(eventSid)].reverse().find((message) => (
              message.role === "assistant"
              && Boolean(message.content.trim())
              && !message.toolCalls?.length
              && !message.isCompactionSummary
            ));
            if (completedMessage) {
              updateMessage(completedMessage.id, (message) => ({
                ...message,
                presentation: {
                  ...message.presentation,
                  completionDurationMs: durationMs,
                },
              }), eventSid);
            }
          }
        }
        clearRuntimeProgress(eventSid);
        // Only clear running state here if no queued messages — otherwise
        // startRun's finally block will chain the next run seamlessly.
        if (isViewed && !useAgentStore.getState().messages.some(m => m.isQueued)) {
          setRunningSession(null);
        }
        if (isViewed) {
          updateAgentActivity("idle");
          // Auto voice output uses the configured local/remote TTS model only.
          if (useUIStore.getState().autoSpeak) {
            const msgs = useAgentStore.getState().messages;
            const lastAssistant = [...msgs].reverse().find(
              (m) => m.role === "assistant" && m.content && !m.isCompactionSummary,
            );
            if (lastAssistant?.content) {
              if (window.agentApi?.ttsSpeak) {
                stopSpeaking();
                void window.agentApi.ttsSpeak(lastAssistant.content.slice(0, 600)).then((result) => {
                  if (!result.ok) setError("TTS 模型播报失败");
                }).catch((error) => {
                  setError(error instanceof Error ? error.message : "TTS 模型播报失败");
                });
              }
            }
          }
        }
        if (eventSid) {
          if (managedRunSessionsRef.current.has(eventSid)) {
            window.setTimeout(() => { void loadGoalState(eventSid); }, 150);
          } else {
            scheduleQueuedMessageAfterTerminal(eventSid);
          }
        }
        break;
      case "error":
        if (!event._preserveActiveRun) clearRuntimeProgress(eventSid);
        if (isViewed) {
          if (event._preserveActiveRun && eventSid) {
            preserveNativeConflictRef.current.add(eventSid);
            runningSessionRef.current = eventSid;
            setRunningSession(eventSid);
            updateAgentActivity("thinking");
          }
          if (event.code === "SESSION_ALREADY_RUNNING") {
            const conflictMessages = eventSid
              ? useAgentStore.getState().getMessagesForSession(eventSid)
              : useAgentStore.getState().messages;
            const rejectedMessageId = findLatestUnqueuedUserMessageId(conflictMessages);
            if (rejectedMessageId) {
              const rejectedMessage = conflictMessages.find((message) => message.id === rejectedMessageId);
              updateMessage(rejectedMessageId, (message) => ({ ...message, isQueued: true }), eventSid);
              if (
                hasDurableMessageQueue
                && eventSid?.startsWith("runtime:")
                && rejectedMessage
                && window.agentApi?.enqueueSessionMessage
              ) {
                void window.agentApi.enqueueSessionMessage(eventSid, {
                  sourceMessageId: rejectedMessage.id,
                  content: rejectedMessage.content,
                  images: rejectedMessage.images,
                  agentName: rejectedMessage.agentName,
                }).then((state) => applySessionQueueState(state, eventSid)).catch((queueError) => {
                  setError(queueError instanceof Error ? queueError.message : "排队消息保存失败");
                });
              }
            }
            setOccupiedDraft(undefined);
            setSessionError(undefined);
            setError(null);
          } else if (event.code === "SESSION_OCCUPIED") {
            const failedMessages = eventSid
              ? useAgentStore.getState().getMessagesForSession(eventSid)
              : useAgentStore.getState().messages;
            const failedUserMessage = [...failedMessages].reverse().find(
              (message) => message.role === "user" && !message.isQueued,
            );
            setOccupiedDraft(failedUserMessage?.content);
            if (failedUserMessage?.content) {
              setInput(failedUserMessage.content);
              if (eventSid) writeSessionDraft(eventSid, failedUserMessage.content);
            }
            if (eventSid) setSessionError({ sessionId: eventSid, code: event.code });
            setError(null);
          } else {
            setError(event.message ?? "Unknown error");
            const failedMessages = eventSid
              ? useAgentStore.getState().getMessagesForSession(eventSid)
              : useAgentStore.getState().messages;
            const failedUserMessage = [...failedMessages].reverse().find((message) => message.role === "user" && !message.isQueued);
            if (isNativeRuntime && failedUserMessage?.content) {
              setInput(failedUserMessage.content);
              if (eventSid) writeSessionDraft(eventSid, failedUserMessage.content);
            }
          }
          if (!event._preserveActiveRun) {
            setRunningSession(null);
            updateAgentActivity("idle");
          }
        }
        if (eventSid && !event._preserveActiveRun) {
          if (managedRunSessionsRef.current.has(eventSid)) {
            window.setTimeout(() => { void loadGoalState(eventSid); }, 150);
          } else {
            scheduleQueuedMessageAfterTerminal(eventSid);
          }
        }
        break;
      case "turn_aborted":
        clearRuntimeProgress(eventSid);
        if (isViewed) {
          setRunningSession(null);
          updateAgentActivity("idle");
        }
        break;
    }
  };

  const handlePermissionModeChange = async (mode: ToolPermissionMode) => {
    if (!viewSessionId || !window.agentApi?.setSessionPermissionMode || isSavingPermission) return;
    const previous = permissionMode;
    setPermissionMode(mode);
    setPermissionMenuOpen(false);
    setIsSavingPermission(true);
    try {
      await window.agentApi.setSessionPermissionMode(viewSessionId, mode);
    } catch (error) {
      setPermissionMode(previous);
      setError(error instanceof Error ? error.message : "权限模式更新失败");
    } finally {
      setIsSavingPermission(false);
    }
  };

  const handleDesktopHandoff = async () => {
    if (!viewSessionId || !window.agentApi?.handoffSession) return;
    try {
      await window.agentApi.handoffSession(viewSessionId);
      setError(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : "交接到 Desktop 失败");
    }
  };

  const handleForkOccupiedSession = async () => {
    if (!viewSessionId || !window.agentApi?.forkSession || isForkingSession) return;
    setIsForkingSession(true);
    try {
      await forkOccupiedCodexSession({
        sourceSessionId: viewSessionId,
        forkSession: (id) => window.agentApi!.forkSession(id),
        activateSession: (id) => {
          sessionIdRef.current = id;
          setSessionId(id);
        },
        refreshAndSelect: async (forked) => {
          if (onSessionCreated) await onSessionCreated(forked.id, forked);
          else onSelectSession?.(forked.id);
        },
      });
      if (occupiedDraft) setInput(occupiedDraft);
      setOccupiedDraft(undefined);
      setSessionError(undefined);
      setError(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : "创建会话副本失败");
    } finally {
      setIsForkingSession(false);
    }
  };

  const handleAbort = () => {
    abortRef.current = true;
    sessionLoadGenerationRef.current += 1;
    if (window.agentApi) {
      void window.agentApi.abort(viewSessionId || undefined);
    }
    runningSessionRef.current = null;
    setRunningSession(null);
    runningSubIdsRef.current.clear();
  };

  /**
   * Steer a queued user message into the currently running agent loop.
   * The message is injected via the steer IPC so AgentLoop picks it up
   * on its next iteration.
   */
  const handleSteer = async (msgId: string) => {
    const targetSessionId = selectedSessionId || sessionId;
    if (!targetSessionId || !window.agentApi) return;
    const msg = useAgentStore.getState().messages.find(m => m.id === msgId);
    if (!msg || !msg.isQueued) return;
    try {
      if (msg.queueItemId && targetSessionId.startsWith("runtime:")) {
        applySessionQueueState(
          await window.agentApi.steerSessionMessage(targetSessionId, msg.queueItemId),
          targetSessionId,
        );
      } else {
        await window.agentApi.steer(msg.content, targetSessionId, msg.agentName);
        updateMessage(msgId, (m) => ({ ...m, isQueued: false, isSteered: true }));
      }
      if (editingQueuedId === msgId) {
        setEditingQueuedId(null);
        setQueuedEditDraft("");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "引导失败");
    }
  };

  const beginQueuedMessageEdit = (msgId: string) => {
    const message = useAgentStore.getState().messages.find((item) => item.id === msgId && item.isQueued);
    if (!message) return;
    setEditingQueuedId(msgId);
    setQueuedEditDraft(message.content);
  };

  const cancelQueuedMessageEdit = () => {
    setEditingQueuedId(null);
    setQueuedEditDraft("");
  };

  const saveQueuedMessageEdit = async (msgId: string) => {
    const content = queuedEditDraft.trim();
    const message = useAgentStore.getState().messages.find((item) => item.id === msgId && item.isQueued);
    if (!message || !content) return;
    try {
      if (message.queueItemId && viewSessionId?.startsWith("runtime:")) {
        applySessionQueueState(
          await window.agentApi.updateSessionMessage(viewSessionId, message.queueItemId, content),
          viewSessionId,
        );
      } else {
        updateMessage(msgId, (item) => item.isQueued ? { ...item, content } : item, viewSessionId || undefined);
      }
      cancelQueuedMessageEdit();
    } catch (queueError) {
      setError(queueError instanceof Error ? queueError.message : "排队消息保存失败");
    }
  };

  const copyQueuedMessage = async (msgId: string) => {
    const message = useAgentStore.getState().messages.find((item) => item.id === msgId && item.isQueued);
    if (!message) return;
    if (!await copyTextToClipboard(message.content)) {
      setError("复制排队消息失败");
      return;
    }
    setCopiedQueuedId(msgId);
    window.setTimeout(() => setCopiedQueuedId((current) => current === msgId ? null : current), 1_200);
  };

  const deleteQueuedMessage = async (msgId: string) => {
    const currentMessages = useAgentStore.getState().messages;
    const message = currentMessages.find((item) => item.id === msgId && item.isQueued);
    if (!message) return;
    try {
      if (message.queueItemId && viewSessionId?.startsWith("runtime:")) {
        applySessionQueueState(
          await window.agentApi.cancelSessionMessage(viewSessionId, message.queueItemId),
          viewSessionId,
        );
      } else {
        setMessages(currentMessages.filter((item) => item.id !== msgId), viewSessionId || undefined);
      }
      if (editingQueuedId === msgId) cancelQueuedMessageEdit();
    } catch (queueError) {
      setError(queueError instanceof Error ? queueError.message : "排队消息删除失败");
    }
  };

  const reorderQueuedMessage = async (sourceId: string, targetId: string) => {
    const currentMessages = useAgentStore.getState().messages;
    const reordered = moveQueuedMessage(currentMessages, sourceId, targetId);
    if (reordered !== currentMessages) {
      setMessages(reordered, viewSessionId || undefined);
      const durable = reordered.filter((message) => message.isQueued && message.queueItemId);
      if (viewSessionId?.startsWith("runtime:") && durable.length > 0) {
        try {
          applySessionQueueState(
            await window.agentApi.reorderSessionMessages(
              viewSessionId,
              durable.map((message) => message.queueItemId!),
            ),
            viewSessionId,
          );
        } catch (queueError) {
          setMessages(currentMessages, viewSessionId);
          setError(queueError instanceof Error ? queueError.message : "排队消息排序保存失败");
        }
      }
    }
  };

  const moveQueuedMessageByKeyboard = (msgId: string, direction: -1 | 1) => {
    const queued = useAgentStore.getState().messages.filter((message) => message.isQueued);
    const currentIndex = queued.findIndex((message) => message.id === msgId);
    const target = queued[currentIndex + direction];
    if (target) void reorderQueuedMessage(msgId, target.id);
  };

  const dropQueuedGoal = async (targetGoalId: string) => {
    const sourceGoalId = draggedGoalId;
    setDraggedGoalId(null);
    if (!viewSessionId || !sourceGoalId || sourceGoalId === targetGoalId) return;
    const orderedIds = goalState.queued.map((goal) => goal.id);
    const from = orderedIds.indexOf(sourceGoalId);
    const to = orderedIds.indexOf(targetGoalId);
    if (from < 0 || to < 0) return;
    const nextIds = [...orderedIds];
    nextIds.splice(to, 0, nextIds.splice(from, 1)[0]);
    const previous = goalState;
    setGoalState({
      ...goalState,
      queued: nextIds.map((id, position) => ({
        ...goalState.queued.find((goal) => goal.id === id)!,
        position,
      })),
    });
    try {
      applySessionQueueState(await window.agentApi.reorderSessionGoals(viewSessionId, nextIds), viewSessionId);
    } catch (goalError) {
      setGoalState(previous);
      setError(goalError instanceof Error ? goalError.message : "目标排序保存失败");
    }
  };

  const removeGoal = async (goalId: string) => {
    if (!viewSessionId) return;
    const queuedGoal = goalState.queued.find((goal) => goal.id === goalId);
    try {
      const state = await window.agentApi.cancelSessionGoal(viewSessionId, goalId);
      applySessionQueueState(state, viewSessionId);
      if (queuedGoal?.sourceMessageId) {
        const currentMessages = useAgentStore.getState().getMessagesForSession(viewSessionId);
        setMessages(
          currentMessages.filter((message) => message.id !== queuedGoal.sourceMessageId),
          viewSessionId,
        );
      }
      if (!state.active) setRunningSession(null);
    } catch (goalError) {
      setError(goalError instanceof Error ? goalError.message : "目标删除失败");
    }
  };

  useEffect(() => {
    if (!editingQueuedId) return;
    if (messages.some((message) => message.id === editingQueuedId && message.isQueued)) return;
    setEditingQueuedId(null);
    setQueuedEditDraft("");
  }, [editingQueuedId, messages]);

  /**
   * Unified run launcher — starts an agent run and processes the message
   * queue in the finally block.  When the current run finishes, the next
   * queued message (if any and the user didn't abort) is automatically
   * started as a new run.
   */
  async function startRun(
    message: { content: string; agentName?: string; images?: string[] },
    targetSessionId: string,
    agentIds?: string[],
  ) {
    abortRef.current = false;
    managedRunSessionsRef.current.add(targetSessionId);
    beginAgentRunActivity(targetSessionId);
    runningSessionRef.current = targetSessionId;
    setRunningSession(targetSessionId);
    try {
      if (window.agentApi) {
        const runNativeOptions = isNativeRuntime && isNativeAgentType(composerAgentType) ? {
          ...(nativePref.model?.id ? { model: nativePref.model } : {}),
          ...(activeNativeEffort ? { reasoningEffort: activeNativeEffort } : {}),
        } : undefined;
        await window.agentApi.run(
          message.content,
          targetSessionId,
          agentIds,
          message.agentName,
          message.images,
          runNativeOptions,
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Agent run failed");
    } finally {
      managedRunSessionsRef.current.delete(targetSessionId);
      const preserveRecoveredRun = preserveNativeConflictRef.current.delete(targetSessionId);
      if (preserveRecoveredRun) {
        runningSessionRef.current = targetSessionId;
        setRunningSession(targetSessionId);
        return;
      }
      const pendingGoals = window.agentApi?.getSessionGoals
        ? await window.agentApi.getSessionGoals(targetSessionId).catch(() => undefined)
        : undefined;
      if (pendingGoals && targetSessionId === (selectedSessionIdRef.current || sessionIdRef.current)) {
        applySessionQueueState(pendingGoals, targetSessionId);
      }
      // A goal queued during an ordinary run owns the next native slot. Its
      // terminal event drains ordinary queued chat after all goals finish.
      if (pendingGoals?.active) {
        runningSessionRef.current = targetSessionId;
        setRunningSession(targetSessionId);
        if (onRunComplete) void onRunComplete(selectedProjectId, targetSessionId);
        return;
      }
      // Check for next queued message (skip if user aborted)
      const nextQueued = !abortRef.current
        ? useAgentStore.getState().getMessagesForSession(targetSessionId).find(
            (message) => message.isQueued && !message.queueItemId,
          )
        : undefined;
      if (nextQueued) {
        updateMessage(nextQueued.id, (m) => ({ ...m, isQueued: false }), targetSessionId);
        if (onRunComplete) void onRunComplete(selectedProjectId, targetSessionId);
        void startRun(nextQueued, targetSessionId);
      } else {
        runningSessionRef.current = null;
        setRunningSession(null);
        if (onRunComplete) void onRunComplete(selectedProjectId, targetSessionId);
      }
    }
  }

  const handleSend = async () => {
    if (!input.trim() || !canCompose || pendingImageReads > 0) return;

    if (historyWindowModeRef.current === "anchored") {
      const restoredLatest = await returnToLatestHistory();
      if (!restoredLatest) return;
    }

    void interruptSpeech(window.agentApi, stopSpeaking);

    setError(null);

    const userMsg = input.trim();

    // ── /loop command handling ─────────────────────────────────────────────
    if (/^\/loop\b/i.test(userMsg)) {
      const rest = userMsg.slice(5).trim();
      setInput("");
      addMessage({ id: crypto.randomUUID(), role: "user", content: userMsg, timestamp: Date.now() });

      // /loop stop — stop all
      if (/^stop$/i.test(rest)) {
        if (window.agentApi) {
          await window.agentApi.cronDeleteAll();
          setCronTasks([]);
          addMessage({ id: crypto.randomUUID(), role: "assistant", content: "✅ 所有定时任务已删除。", timestamp: Date.now() });
        }
        return;
      }

      // /loop list / status — show list
      if (/^(?:list|status|查看|列表)$/i.test(rest) || rest === "") {
        if (window.agentApi) {
          const list = await window.agentApi.cronList();
          setCronTasks(list);
          const msg = list.length === 0
            ? "当前没有定时任务。"
            : list.map((t, i) =>
                `**${i + 1}.** \`${t.id.slice(0, 6)}\` · ${describeCron(t.cron)} · ${t.enabled ? "▶ 启用" : "⏸ 已暂停"}\n${t.prompt}`
              ).join("\n\n");
          addMessage({ id: crypto.randomUUID(), role: "assistant", content: msg, timestamp: Date.now() });
        }
        return;
      }

      // /loop pause <id>
      const pauseMatch = rest.match(/^(?:pause|暂停)\s+(\S+)$/i);
      if (pauseMatch) {
        if (window.agentApi) {
          const full = cronTasks.find(t => t.id.startsWith(pauseMatch[1]));
          const result = await window.agentApi.cronPause(full?.id ?? pauseMatch[1]);
          if (result) {
            const updated = await window.agentApi.cronList();
            setCronTasks(updated);
            addMessage({ id: crypto.randomUUID(), role: "assistant", content: `⏸ 定时任务 \`${result.id.slice(0, 6)}\` 已暂停。`, timestamp: Date.now() });
          } else {
            addMessage({ id: crypto.randomUUID(), role: "assistant", content: `未找到 ID 以 \`${pauseMatch[1]}\` 开头的定时任务。`, timestamp: Date.now() });
          }
        }
        return;
      }

      // /loop resume <id>
      const resumeMatch = rest.match(/^(?:resume|恢复)\s+(\S+)$/i);
      if (resumeMatch) {
        if (window.agentApi) {
          const full = cronTasks.find(t => t.id.startsWith(resumeMatch[1]));
          const result = await window.agentApi.cronResume(full?.id ?? resumeMatch[1]);
          if (result) {
            const updated = await window.agentApi.cronList();
            setCronTasks(updated);
            addMessage({ id: crypto.randomUUID(), role: "assistant", content: `▶ 定时任务 \`${result.id.slice(0, 6)}\` 已恢复。`, timestamp: Date.now() });
          } else {
            addMessage({ id: crypto.randomUUID(), role: "assistant", content: `未找到 ID 以 \`${resumeMatch[1]}\` 开头的定时任务。`, timestamp: Date.now() });
          }
        }
        return;
      }

      // /loop delete <id>
      const deleteMatch = rest.match(/^(?:delete|del|删除|stop)\s+(\S+)$/i);
      if (deleteMatch) {
        if (window.agentApi) {
          const full = cronTasks.find(t => t.id.startsWith(deleteMatch[1]));
          const ok = await window.agentApi.cronDelete(full?.id ?? deleteMatch[1]);
          if (ok) {
            const updated = await window.agentApi.cronList();
            setCronTasks(updated);
            addMessage({ id: crypto.randomUUID(), role: "assistant", content: `🗑 定时任务 \`${deleteMatch[1]}\` 已删除。`, timestamp: Date.now() });
          } else {
            addMessage({ id: crypto.randomUUID(), role: "assistant", content: `未找到 ID 以 \`${deleteMatch[1]}\` 开头的定时任务。`, timestamp: Date.now() });
          }
        }
        return;
      }

      // /loop <interval|cron> <task> — create a new cron task
      const loopMatch = rest.match(/^(\S+)\s+(.+)$/s);
      if (loopMatch) {
        const cronExpr = loopMatch[1];
        const prompt = loopMatch[2].trim();
        if (window.agentApi) {
          let targetSessionId = selectedSessionId || sessionId;
          if (!targetSessionId) {
            const created = await window.agentApi.createSession(prompt.slice(0, 60) || "定时任务", selectedProjectId || undefined) as { id: string };
            targetSessionId = created.id;
            setSessionId(created.id);
            if (onSessionCreated) await onSessionCreated(created.id);
          }
          try {
            const result = await window.agentApi.cronCreate(cronExpr, prompt, { sessionId: targetSessionId });
            const updated = await window.agentApi.cronList();
            setCronTasks(updated);
            addMessage({
              id: crypto.randomUUID(), role: "assistant",
              content: `⏰ 定时任务已创建（ID: \`${result.id.slice(0, 6)}\`），${describeCron(cronExpr)}执行：${prompt}`,
              timestamp: Date.now(),
            });
          } catch (err) {
            addMessage({ id: crypto.randomUUID(), role: "assistant", content: `❌ 创建失败：${err instanceof Error ? err.message : String(err)}`, timestamp: Date.now() });
          }
        }
        return;
      }

      // Unknown subcommand — show help
      addMessage({
        id: crypto.randomUUID(), role: "assistant",
        content: "**定时任务用法：**\n- `/loop <间隔/cron> <任务>` — 创建，如 `/loop 5m 检查系统状态` 或 `/loop 0 9 * * * 早报`\n- `/loop list` — 查看所有定时任务\n- `/loop pause <id>` — 暂停\n- `/loop resume <id>` — 恢复\n- `/loop delete <id>` — 删除\n- `/loop stop` — 删除全部\n\n间隔支持：`30s`、`5m`、`2h`；也支持 5 字段 cron 表达式。",
        timestamp: Date.now(),
      });
      return;
    }

    // ── Natural language loop detection ────────────────────────────────────
    const nlLoopMatch = userMsg.match(
      /(?:每(?:隔)?|定时每)\s*(\d+(?:\.\d+)?)\s*(分钟|秒|小时|min|sec|h)\s*(.+)/is,
    );
    if (nlLoopMatch) {
      const intervalExpr = nlLoopMatch[1] + nlLoopMatch[2];
      const prompt = nlLoopMatch[3].trim();
      if (prompt && window.agentApi) {
        let targetSessionId = selectedSessionId || sessionId;
        if (!targetSessionId) {
          const created = await window.agentApi.createSession(prompt.slice(0, 60) || "定时任务", selectedProjectId || undefined) as { id: string };
          targetSessionId = created.id;
          setSessionId(created.id);
          if (onSessionCreated) await onSessionCreated(created.id);
        }
        try {
          const result = await window.agentApi.cronCreate(intervalExpr, prompt, { sessionId: targetSessionId });
          const updated = await window.agentApi.cronList();
          setCronTasks(updated);
          setInput("");
          addMessage({ id: crypto.randomUUID(), role: "user", content: userMsg, timestamp: Date.now() });
          addMessage({
            id: crypto.randomUUID(), role: "assistant",
            content: `⏰ 定时任务已创建（ID: \`${result.id.slice(0, 6)}\`），${describeCron(intervalExpr)}执行：${prompt}`,
            timestamp: Date.now(),
          });
        } catch (err) {
          addMessage({ id: crypto.randomUUID(), role: "assistant", content: `❌ 创建失败：${err instanceof Error ? err.message : String(err)}`, timestamp: Date.now() });
        }
        return;
      }
    }
    // ──────────────────────────────────────────────────────────────────────

    // Preserve slash skill syntax. Each runtime adapter maps it to its native
    // invocation format (Customer Agent `/name`, Claude `/name`, Codex `$name`).
    const finalMsg = input.trim();
    const explicitGoal = finalMsg.match(/^\/goal(?:\s+([\s\S]+))?$/i);
    const goalObjective = explicitGoal ? explicitGoal[1]?.trim() ?? "" : goalMode ? finalMsg : null;
    if (goalObjective !== null && !goalObjective) {
      setError("请输入目标内容");
      return;
    }

    const agentNamesLabel = pendingAgents.length > 0
      ? pendingAgents.map(a => a.name).join(", ")
      : undefined;
    const imagesToSend = pendingImages.length > 0 ? [...pendingImages] : undefined;
    const agentIdsToSend = pendingAgents.map(a => a.id);
    setPendingAgents([]);
    if (isNativeRuntime && (selectedSessionId || sessionId)) preserveNativeDraftRef.current = true;
    setInput("");
    setAttachedFiles([]);
    setPendingImages([]);

    if (goalObjective !== null) {
      const sourceMessageId = crypto.randomUUID();
      let optimisticSessionId: string | null = null;
      abortRef.current = false;
      try {
        const targetSessionId = await prepareChatCommand({
          text: goalObjective,
          projectId: selectedProjectId ?? null,
          sessionId: selectedSessionId || sessionId,
          createSession: async (title, projectId) => {
            if (!window.agentApi) throw new Error("agentApi 未就绪");
            return await window.agentApi.createSession(title, projectId) as { id: string };
          },
          activateSession: (id) => {
            sessionIdRef.current = id;
            setSessionId(id);
            runningSessionRef.current = id;
            setRunningSession(id);
          },
          showUserMessage: (text, id) => {
            optimisticSessionId = id;
            addMessage({
              id: sourceMessageId,
              role: "user",
              content: text,
              timestamp: Date.now(),
              agentName: agentNamesLabel,
              images: imagesToSend,
              isGoal: true,
              goalId: sourceMessageId,
            }, id);
          },
          onSessionCreated,
        });
        const state = await window.agentApi.enqueueSessionGoal(
          targetSessionId,
          goalObjective,
          sourceMessageId,
        );
        applySessionQueueState(state, targetSessionId);
        if (onMessageSent) void onMessageSent(targetSessionId, goalObjective);
      } catch (goalError) {
        if (optimisticSessionId) {
          const currentMessages = useAgentStore.getState().getMessagesForSession(optimisticSessionId);
          setMessages(
            currentMessages.filter((message) => message.id !== sourceMessageId),
            optimisticSessionId,
          );
        }
        setRunningSession(null);
        setError(goalError instanceof Error ? goalError.message : "目标创建失败");
      }
      return;
    }

    // ── Queue message if agent is running ──────────────────────────────────
    if (shouldQueueMessage) {
      const sourceMessageId = crypto.randomUUID();
      const queuedMessage = {
        id: sourceMessageId,
        role: "user",
        content: finalMsg,
        timestamp: Date.now(),
        agentName: agentNamesLabel,
        images: imagesToSend,
        isQueued: true,
      } as const;
      if (isNativeRuntime && hasDurableMessageQueue && viewSessionId && window.agentApi?.enqueueSessionMessage) {
        try {
          const state = await window.agentApi.enqueueSessionMessage(viewSessionId, {
            sourceMessageId,
            content: finalMsg,
            images: imagesToSend,
            agentIds: agentIdsToSend,
            agentName: agentNamesLabel,
          });
          applySessionQueueState(state, viewSessionId);
          if (state.active?.sourceMessageId === sourceMessageId) {
            addMessage({ ...queuedMessage, isQueued: false }, viewSessionId);
          }
        } catch (queueError) {
          setInput(finalMsg);
          setPendingImages(imagesToSend ?? []);
          setError(queueError instanceof Error ? queueError.message : "排队消息保存失败");
        }
      } else {
        addMessage(queuedMessage);
      }
      return;
    }

    // ── Normal send flow ───────────────────────────────────────────────────
    setTodos([]);  // clear previous run's todos on new message

    try {
      const targetSessionId = await prepareChatCommand({
        text: finalMsg,
        projectId: selectedProjectId ?? null,
        sessionId: selectedSessionId || sessionId,
        createSession: async (title, projectId) => {
          if (!window.agentApi) throw new Error("agentApi 未就绪");
          return await window.agentApi.createSession(title, projectId) as { id: string };
        },
        activateSession: (id) => {
          sessionIdRef.current = id;
          setSessionId(id);
          // Mark running before selection changes so history loading preserves
          // the optimistic message for this session.
          runningSessionRef.current = id;
          setRunningSession(id);
        },
        showUserMessage: (text, id) => addMessage({
          id: crypto.randomUUID(),
          role: "user",
          content: text,
          timestamp: Date.now(),
          agentName: agentNamesLabel,
          images: imagesToSend,
        }, id),
        onSessionCreated,
      });

      // Notify immediately so sidebar title updates before agent finishes
      if (onMessageSent) {
        void onMessageSent(targetSessionId, finalMsg);
      }

      await startRun(
        { content: finalMsg, agentName: agentNamesLabel, images: imagesToSend },
        targetSessionId,
        agentIdsToSend.length > 0 ? agentIdsToSend : undefined,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Agent run failed");
    }
  };

  // ── Voice command from wake word ───────────────────────────────────────
  // Create a fresh session — under the project mentioned in the command when
  // one was matched, otherwise a plain session — and run the agent, all
  // without any user interaction.
  useEffect(() => {
    if (!voiceCommand || !window.agentApi) return;
    const { text, projectId, sessionId } = voiceCommand;
    let cancelled = false;
    (async () => {
      try {
        setTodos([]);
        const targetSessionId = await prepareVoiceCommand({
          text,
          projectId,
          sessionId,
          createSession: async (title, targetProjectId) => (
            await window.agentApi.createSession(title, targetProjectId)
          ) as { id: string },
          activateSession: (targetId) => {
            sessionIdRef.current = targetId;
            setSessionId(targetId);
            runningSessionRef.current = targetId;
            setRunningSession(targetId);
          },
          showUserMessage: (message, targetId) => addMessage({
            id: crypto.randomUUID(),
            role: "user",
            content: message,
            timestamp: Date.now(),
          }, targetId),
          onSessionCreated,
          isCancelled: () => cancelled,
        });
        if (!targetSessionId) return;
        if (onMessageSent) void onMessageSent(targetSessionId, text);
        await startRun({ content: text }, targetSessionId);
      } catch (err) {
        setError(err instanceof Error ? err.message : "语音指令执行失败");
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceCommand?.nonce]);

  return (
    <div className="chat-view chat-view--codex-history" style={{
      display: "flex",
      flexDirection: "column",
      height: "100%",
      maxWidth: "var(--chat-max-width)",
      margin: "0 auto",
    }}>
      {/* ── Top bar: title + settings ── */}
      <div className="chat-top-bar" style={{
        display: "flex",
        alignItems: "center",
        padding: "var(--chat-header-padding)",
        height: "var(--chat-header-height)",
        flexShrink: 0,
        borderBottom: "1px solid var(--border-subtle)",
        WebkitAppRegion: "no-drag",
      } as React.CSSProperties}>
        <span style={{
          flex: 1,
          minWidth: 0,
          fontSize: 14,
          fontWeight: 500,
          color: sessionTitle ? "var(--text-primary)" : "var(--text-muted)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          letterSpacing: "-0.01em",
        }}>
          {sessionTitle || "会话"}
        </span>
        {onOpenSettings && onHideToBackground && onToggleAppearance && (
          <ChatHeaderActions
            appearanceOpen={appearanceOpen}
            settingsOpen={settingsOpen}
            hideToBackgroundTitle={hideToBackgroundTitle}
            onHideToBackground={onHideToBackground}
            onToggleAppearance={onToggleAppearance}
            onOpenSettings={onOpenSettings}
          />
        )}
      </div>

      {/* Messages area */}
      <div className="chat-messages-frame">
        <div ref={messagesScrollRef} className="chat-messages" onScroll={handleHistoryScroll} style={{
          overflow: "auto",
          position: "relative",
          padding: "var(--chat-messages-padding)",
        }}>

        {messages.length > 0 && (isLoadingOlderHistory || olderHistoryError) && (
          <div
            className="chat-history-page-status"
            role={olderHistoryError ? "alert" : "status"}
            style={{
              position: "absolute",
              top: 8,
              left: "50%",
              transform: "translateX(-50%)",
              zIndex: 2,
              minHeight: 32,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 7,
              color: olderHistoryError ? "var(--danger)" : "var(--text-muted)",
              fontSize: 12,
            }}
          >
            {isLoadingOlderHistory ? (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ animation: "spin 0.8s linear infinite" }} aria-hidden="true">
                  <path d="M21 12a9 9 0 1 1-6.22-8.56" />
                </svg>
                <span>正在加载更早消息</span>
              </>
            ) : (
              <button
                type="button"
                onClick={() => void loadOlderHistory()}
                className="chat-history-retry"
                style={{
                  border: "1px solid color-mix(in srgb, var(--danger) 30%, transparent)",
                  background: "color-mix(in srgb, var(--danger) 7%, transparent)",
                  color: "var(--danger)",
                  borderRadius: 6,
                  padding: "5px 10px",
                  cursor: "pointer",
                  fontSize: 12,
                }}
              >
                {olderHistoryError}，点击重试
              </button>
            )}
          </div>
        )}

        {messages.length === 0 && isInitialHistoryLoading && showInitialHistoryLoading && (
          <div className="chat-history-initial-loading" role="status" style={{
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 9,
            color: "var(--text-muted)",
            fontSize: 13,
          }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" style={{ animation: "spin 0.8s linear infinite" }} aria-hidden="true">
              <path d="M21 12a9 9 0 1 1-6.22-8.56" />
            </svg>
            <span>正在加载历史消息</span>
          </div>
        )}

        {messages.length === 0 && !isRunning && !isInitialHistoryLoading && !error && (
          <EmptySessionWelcome
            key={viewSessionId ?? "initial-empty-session"}
            agentType={sessionSummary?.agentType ?? activeAgentType}
            ready={canCompose}
            onSelectPrompt={selectStarterPrompt}
          />
        )}

        {renderedMessages.map((msg, i) => {
          const chatMsg = msg as import("../stores/agentStore").ChatMessage;
          // Skip queued messages — they are rendered in the queue bar above the input
          if (chatMsg.isQueued) return null;
          const isUser = msg.role === "user";
          const isGoalMessage = isUser && (
            chatMsg.isGoal === true
            || [goalState.active, ...goalState.queued, ...goalState.history]
              .some((goal) => Boolean(goal && normalizeGoalMessageText(goal.objective) === normalizeGoalMessageText(msg.content)))
          );
          const actionPolicy = messageActionPolicy(renderedMessages, i, isRunning);
          const completionDuration = formatCompletionDuration(chatMsg.presentation?.completionDurationMs);

          // ── Compaction banner ──────────────────────────────────────────
          if (chatMsg.isCompactionSummary) {
            return (
              <div key={msg.id} style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                margin: "20px 0",
                color: "var(--text-muted)",
                fontSize: 12,
              }}>
                <div style={{ flex: 1, height: 1, background: "var(--border-subtle)" }} />
                <div style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "4px 12px",
                  borderRadius: 20,
                  border: "1px solid var(--border-subtle)",
                  background: "var(--bg-deep)",
                  color: "var(--text-muted)",
                  fontSize: 11,
                  cursor: "default",
                  userSelect: "none",
                }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="17 1 21 5 17 9"/>
                    <path d="M3 11V9a4 4 0 0 1 4-4h14"/>
                    <polyline points="7 23 3 19 7 15"/>
                    <path d="M21 13v2a4 4 0 0 1-4 4H3"/>
                  </svg>
                  上下文已压缩
                </div>
                <div style={{ flex: 1, height: 1, background: "var(--border-subtle)" }} />
              </div>
            );
          }

          // ── Widget card ────────────────────────────────────────
          if (chatMsg.widget) {
            const WidgetComponent = widgetRegistry[chatMsg.widget.widgetType];
            if (WidgetComponent) {
              return (
                <div key={msg.id} style={{ marginBottom: 16, display: "flex", justifyContent: "flex-start" }}>
                  <WidgetComponent {...chatMsg.widget.data} widgetId={chatMsg.widget.widgetId} />
                </div>
              );
            }
            // Fallback: show raw JSON
            return (
              <div key={msg.id} style={{
                marginBottom: 16,
                padding: 12,
                borderRadius: 8,
                background: "var(--bg-surface)",
                border: "1px solid var(--border-subtle)",
                fontFamily: "var(--font-mono, monospace)",
                fontSize: 12,
                whiteSpace: "pre-wrap",
                maxHeight: 300,
                overflow: "auto",
              }}>
                {JSON.stringify(chatMsg.widget.data, null, 2)}
              </div>
            );
          }

          // ── Ask User card ───────────────────────────────────────
          if (chatMsg.askUser) {
            return (
              <AskUserCard
                key={msg.id}
                questionId={chatMsg.askUser.questionId}
                question={chatMsg.askUser.question}
                options={chatMsg.askUser.options}
                fields={chatMsg.askUser.fields}
                multiSelect={chatMsg.askUser.multiSelect}
                answered={chatMsg.askUser.answered}
                answer={chatMsg.askUser.answer}
                onAnswer={(answer, selectedIndices) => {
                  // Mark as answered in the message list
                  updateMessage(msg.id, (m) => ({
                    ...m,
                    askUser: { ...m.askUser!, answered: true, answer },
                  }));
                  // Send answer back to main process
                  window.agentApi?.answerQuestion(
                    chatMsg.askUser!.questionId,
                    answer,
                    selectedIndices,
                  );
                }}
              />
            );
          }
          // User avatar label: first char of @mentioned agent, else "你"
          const userAvatarLabel = chatMsg.agentName
            ? chatMsg.agentName.charAt(0).toUpperCase()
            : "你";

          const isLastAssistant = !isUser && i === renderedMessages.length - 1;

          // Use larger bottom margin when the NEXT message switches role (turn boundary).
          const nextMsg = renderedMessages[i + 1] as import("../stores/agentStore").ChatMessage | undefined;
          const isTurnBoundary = nextMsg && nextMsg.role !== msg.role && !nextMsg.isCompactionSummary;
          const toolCallEntries = (msg.toolCalls ?? []).map((toolCall, toolCallIndex) => {
            let beforeContent: string | undefined;
            if (toolCall.name === "write_file" && toolCall.arguments.file_path) {
              const writePath = toolCall.arguments.file_path as string;
              outer: for (let messageIndex = i; messageIndex >= 0; messageIndex--) {
                const calls = renderedMessages[messageIndex].toolCalls;
                if (!calls) continue;
                const start = messageIndex === i ? toolCallIndex - 1 : calls.length - 1;
                for (let callIndex = start; callIndex >= 0; callIndex--) {
                  const previous = calls[callIndex];
                  if (previous.name === "read_file" && previous.arguments.file_path === writePath && previous.result && !previous.isError) {
                    beforeContent = previous.result;
                    break outer;
                  }
                }
              }
            }
            return {
              toolCall,
              beforeContent,
              progress: toolRuntimeProgress(runtimeProgress, toolCall.id),
              nativeSubagent: nativeSubagents[toolCall.id],
            };
          });
          const toolCallGroups = groupAdjacentToolCallEntries(toolCallEntries);

          return (
          <div
            key={msg.id}
            data-message-id={msg.id}
            className={`chat-message-group${actionPolicy.compact ? " chat-message-group--intermediate" : ""}`}
            style={{ marginBottom: actionPolicy.compact ? 0 : (isTurnBoundary ? "var(--chat-turn-gap)" : "var(--chat-message-gap)") }}
          >
            {/* Main message row */}
          <div
            className={`chat-message-row chat-message-row--${isUser ? "user" : "assistant"}`}
            style={{
              display: "flex",
              flexDirection: isUser ? "row-reverse" : "row",
              alignItems: "flex-start",
              gap: "var(--chat-row-gap)",
              animation: `fadeInUp 0.3s var(--ease-out) both`,
            }}
          >
            {/* Avatar */}
            {isUser ? (
              <div className="chat-message-avatar" style={{
                width: "var(--chat-avatar-size)",
                height: "var(--chat-avatar-size)",
                borderRadius: "50%",
                flexShrink: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "var(--accent)",
                color: "#fff",
                fontSize: 12,
                fontWeight: 700,
                letterSpacing: 0,
                userSelect: "none",
              }}>
                {userAvatarLabel}
              </div>
            ) : (
              <div className="chat-message-avatar" style={{
                width: "var(--chat-avatar-size)",
                height: "var(--chat-avatar-size)",
                borderRadius: "50%",
                flexShrink: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "var(--bg-deep)",
                color: "var(--text-muted)",
                border: "1px solid var(--border-subtle)",
              }}>
                {/* Robot icon */}
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="11" width="18" height="10" rx="2"/>
                  <path d="M12 11V7"/>
                  <circle cx="12" cy="5" r="2"/>
                  <circle cx="8" cy="16" r="1" fill="currentColor" stroke="none"/>
                  <circle cx="16" cy="16" r="1" fill="currentColor" stroke="none"/>
                  <path d="M8 20h8"/>
                </svg>
              </div>
            )}

            {/* Bubble */}
            <div className={`chat-message-content chat-message-content--${isUser ? "user" : "assistant"}`} style={{ maxWidth: "var(--chat-content-max-width)", display: "flex", flexDirection: "column", gap: 4, alignItems: isUser ? "flex-end" : "flex-start", minWidth: 0 }}>
              <div className={`chat-message-bubble chat-message-bubble--${isUser ? "user" : "assistant"} ${msg.role === "assistant" && msg.content ? "message-card" : ""}`} style={{
                // Tool-call-only messages: no bubble wrapper — cards render inline
                padding: (msg.content || (isUser && chatMsg.images?.length))
                  ? (isUser ? "var(--chat-user-bubble-padding)" : "var(--chat-assistant-bubble-padding)")
                  : 0,
                borderRadius: isUser
                  ? "14px 4px 14px 14px"
                  : "4px 14px 14px 14px",
                background: (msg.content || (isUser && chatMsg.images?.length)) ? (isUser ? "rgba(79, 110, 247, 0.08)" : undefined) : "transparent",
                border: (msg.content || (isUser && chatMsg.images?.length)) ? (isUser ? "1px solid rgba(79, 110, 247, 0.18)" : undefined) : "none",
                fontSize: "var(--chat-bubble-font-size)",
                lineHeight: "var(--chat-bubble-line-height)",
                color: "var(--text-primary)",
                letterSpacing: "0.01em",
              }}>
                {msg.role === "assistant" && msg.presentation?.reasoning && (
                  <ReasoningSummary
                    sections={msg.presentation.reasoning}
                    streaming={isRunning && isLastAssistant && agentActivity === "thinking"}
                    startedAt={thinkingStartedAt}
                    renderContent={renderAssistantText}
                  />
                )}
                {/* @agent chip + message */}
                {isUser && chatMsg.agentName ? (
                  <div>
                    <span style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 3,
                      fontSize: 10,
                      fontWeight: 700,
                      color: "var(--accent)",
                      background: "var(--accent-dim)",
                      border: "1px solid rgba(79,110,247,0.22)",
                      borderRadius: 10,
                      padding: "1px 7px 1px 5px",
                      letterSpacing: "0.04em",
                      marginRight: 7,
                      verticalAlign: "middle",
                    }}>
                      <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                        <circle cx="12" cy="8" r="4"/><path d="M20 21a8 8 0 1 0-16 0"/>
                      </svg>
                      {chatMsg.agentName}
                    </span>
                    <span style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", verticalAlign: "middle" }}>
                      {msg.content}
                    </span>
                  </div>
                ) : msg.role === "assistant" && msg.content ? (
                  <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                    {renderAssistantText(msg.content)}
                  </div>
                ) : (
                  msg.content && (
                    <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                      {isUser ? msg.content : renderAssistantText(msg.content)}
                    </div>
                  )
                )}
                {/* Images attached to user messages */}
                {isUser && chatMsg.images && chatMsg.images.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: msg.content ? 8 : 0 }}>
                    {chatMsg.images.map((src, idx) => (
                      <button
                        key={idx}
                        type="button"
                        className="chat-message-image-button"
                        aria-label="放大查看图片"
                        onClick={() => setPreviewedMessageImage({ src, alt: `用户发送的图片 ${idx + 1}` })}
                      >
                        <img
                          className="chat-message-attachment-image"
                          src={src}
                          alt={`用户发送的图片 ${idx + 1}`}
                        />
                      </button>
                    ))}
                  </div>
                )}
                {isUser && !chatMsg.images?.length && chatMsg.presentation?.attachments && chatMsg.presentation.attachments.length > 0 && (
                  <div className="chat-message-attachments">
                    {chatMsg.presentation.attachments.map((attachment, idx) => (
                      attachment.dataUrl ? (
                        <button
                          key={`${attachment.name}-${idx}`}
                          type="button"
                          className="chat-message-image-button"
                          aria-label={`放大查看图片：${attachment.name}`}
                          onClick={() => setPreviewedMessageImage({ src: attachment.dataUrl!, alt: attachment.name })}
                        >
                          <img
                            className="chat-message-attachment-image"
                            src={attachment.dataUrl}
                            alt={attachment.name}
                            title={attachment.name}
                          />
                        </button>
                      ) : (
                        <div
                          key={`${attachment.name}-${idx}`}
                          className="chat-message-attachment-unavailable"
                          aria-label={`${attachment.name}，图片已失效`}
                        >
                          <span className="chat-message-attachment-name">{attachment.name}</span>
                          <span>图片已失效</span>
                        </div>
                      )
                    ))}
                  </div>
                )}
                {isUser && chatMsg.presentation?.rawContent && (
                  <details className="chat-message-raw-content">
                    <summary>查看原始内容</summary>
                    <pre>{chatMsg.presentation.rawContent}</pre>
                  </details>
                )}
                {toolCallGroups.map((group) => group.action && group.items.length > 1 ? (
                  <ToolCallGroup
                    key={`group-${group.items[0].toolCall.id}`}
                    items={group.items}
                    onSelectSession={onSelectSession}
                    workspacePath={workspacePath}
                    enableFilePreview={isWebShell()}
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
                    enableFilePreview={isWebShell()}
                  />
                ))}
                {/* File change summary — one compact bar after all tool calls */}
                {(() => {
                  const writes = (msg.toolCalls ?? []).filter(tc => tc.name === "write_file" && tc.result && !tc.isError);
                  if (writes.length === 0) return null;
                  // Aggregate by path, keeping last write
                  const byPath = new Map<string, { path: string; lines: number; added: number; removed: number }>();
                  for (const tc of writes) {
                    const path = tc.arguments.file_path as string ?? "";
                    const content = tc.arguments.content as string ?? "";
                    const newLines = content ? content.split("\n").length : 0;
                    // Find read_file result for this path (search backwards through all messages up to current)
                    let beforeLines = 0;
                    outer2: for (let mi = i; mi >= 0; mi--) {
                      const tcs = renderedMessages[mi].toolCalls ?? [];
                      for (let ti = tcs.length - 1; ti >= 0; ti--) {
                        const p = tcs[ti];
                        if (p.name === "read_file" && p.arguments.file_path === path && p.result && !p.isError) {
                          beforeLines = p.result.split("\n").length;
                          break outer2;
                        }
                      }
                    }
                    byPath.set(path, { path, lines: newLines, added: Math.max(0, newLines - beforeLines), removed: Math.max(0, beforeLines - newLines) });
                  }
                  const entries = [...byPath.values()];
                  return (
                    <div style={{ marginTop: 10, padding: "8px 12px", borderRadius: 8, background: "var(--bg-deep)", border: "1px solid var(--border-subtle)", display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                      <span style={{ fontSize: 10, color: "var(--text-muted)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.07em", flexShrink: 0 }}>变更汇总</span>
                      {entries.map(e => {
                        const previewPath = resolveWebArtifactPath(e.path, workspacePath);
                        const content = <>
                          <span style={{ color: "var(--text-secondary)", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={e.path}>
                            {e.path.replace(/\\/g, "/").split("/").pop()}
                          </span>
                          {e.added > 0 && <span style={{ color: "var(--success)", fontWeight: 600 }}>+{e.added}</span>}
                          {e.removed > 0 && <span style={{ color: "var(--danger)", fontWeight: 600 }}>−{e.removed}</span>}
                          {e.added === 0 && e.removed === 0 && <span style={{ color: "var(--text-muted)" }}>{e.lines}行</span>}
                        </>;
                        return isWebShell() && previewPath ? (
                          <button
                            key={e.path}
                            type="button"
                            className="chat-file-change-link"
                            onClick={() => postWebArtifactOpen(previewPath)}
                            title={`预览 ${previewPath}`}
                            aria-label={`预览改动文件 ${e.path.replace(/\\/g, "/").split("/").pop()}`}
                          >
                            {content}
                          </button>
                        ) : (
                          <span key={e.path} className="chat-file-change-link chat-file-change-link--static">{content}</span>
                        );
                      })}
                    </div>
                  );
                })()}
              </div>
              {/* Completed assistant footer remains visible after the live run disappears. */}
              {actionPolicy.showCompletion && (
                <div className="msg-completion-footer">
                  <span className="msg-completion-status">
                    <Check size={13} strokeWidth={2} aria-hidden="true" />
                    <span>已完成</span>
                    {completionDuration && <span> · 总耗时 {completionDuration}</span>}
                  </span>
                  <span className="msg-completion-actions">
                    {!isWebShell() && actionPolicy.showSpeak && typeof window.agentApi?.ttsSpeak === "function" && (
                      <button
                        type="button"
                        onClick={() => handleSpeakMessage(msg.id, msg.content)}
                        title={speakingMsgId === msg.id ? "停止播报" : "语音播报"}
                        aria-label={speakingMsgId === msg.id ? "停止播报" : "语音播报"}
                        className={`ui-icon-button ui-icon-button--small msg-action-button ${speakingMsgId === msg.id ? "is-active" : ""}`}
                      >
                        {speakingMsgId === msg.id
                          ? <Square size={12} fill="currentColor" aria-hidden="true" />
                          : <Volume2 size={13} strokeWidth={1.8} aria-hidden="true" />}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => { void copyTextToClipboard(msg.content); }}
                      title="复制内容"
                      aria-label="复制内容"
                      className="ui-icon-button ui-icon-button--small msg-action-button"
                    >
                      <Copy size={13} strokeWidth={1.8} aria-hidden="true" />
                    </button>
                  </span>
                </div>
              )}
              {/* User controls and goal markers retain their existing behavior. */}
              {!actionPolicy.showCompletion && (actionPolicy.showCopy || isGoalMessage) && (
                <div className="msg-actions" style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  {isGoalMessage && (
                    <span
                      className="ui-icon-button ui-icon-button--small msg-action-button msg-goal-marker"
                      title="目标消息"
                      aria-label="目标消息"
                      role="img"
                    >
                      <Target size={13} strokeWidth={1.9} aria-hidden="true" />
                    </span>
                  )}
                  {actionPolicy.showCopy && <button
                    type="button"
                    onClick={() => { void copyTextToClipboard(msg.content); }}
                    title="复制内容"
                    aria-label="复制内容"
                    className="ui-icon-button ui-icon-button--small msg-action-button"
                  >
                    <Copy size={13} strokeWidth={1.8} aria-hidden="true" />
                  </button>}
                </div>
              )}
              {/* Queue / Steer badge for queued user messages */}
              {isUser && (chatMsg.isQueued || chatMsg.isSteered) && (
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                  {chatMsg.isQueued && (
                    <>
                      <span style={{
                        display: "inline-flex", alignItems: "center", gap: 4,
                        fontSize: 11, color: "var(--text-muted)",
                        padding: "2px 8px", borderRadius: 20,
                        background: "var(--bg-deep)", border: "1px solid var(--border-subtle)",
                      }}>
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                        </svg>
                        排队中
                      </span>
                      {canSteerQueuedMessages && <button
                        onClick={() => void handleSteer(msg.id)}
                        title="将此消息引导到当前对话"
                        style={{
                          display: "inline-flex", alignItems: "center", gap: 4,
                          fontSize: 11, fontWeight: 600,
                          color: "var(--accent)",
                          padding: "2px 10px", borderRadius: 20,
                          border: "1px solid rgba(79,110,247,0.3)",
                          background: "var(--accent-dim)",
                          cursor: "pointer",
                          transition: "all 0.15s",
                          fontFamily: "var(--font-body)",
                        }}
                        onMouseEnter={e => {
                          (e.currentTarget as HTMLButtonElement).style.background = "rgba(79,110,247,0.18)";
                          (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--accent)";
                        }}
                        onMouseLeave={e => {
                          (e.currentTarget as HTMLButtonElement).style.background = "var(--accent-dim)";
                          (e.currentTarget as HTMLButtonElement).style.borderColor = "rgba(79,110,247,0.3)";
                        }}
                      >
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M3 12h18M3 6h18M3 18h18"/>
                          <path d="M12 3v18" opacity="0.3"/>
                        </svg>
                        引导
                      </button>}
                    </>
                  )}
                  {chatMsg.isSteered && (
                    <span style={{
                      display: "inline-flex", alignItems: "center", gap: 4,
                      fontSize: 11, color: "var(--success)",
                      padding: "2px 8px", borderRadius: 20,
                      background: "rgba(34,197,94,0.08)", border: "1px solid rgba(34,197,94,0.2)",
                    }}>
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12"/>
                      </svg>
                      已引导
                    </span>
                  )}
                </div>
              )}
            </div>
            </div>
          </div>
          );
        })}

        {isRunning && globalRuntimeProgress && (
          <RuntimeProgressRow progress={globalRuntimeProgress} startedAt={thinkingStartedAt} />
        )}

        {/* Keep every otherwise-empty running state visible and consistent. */}
        {showThinkingFallback && (
          <div className="chat-message-activity" style={{
            display: "flex",
            alignItems: "flex-start",
            padding: "4px 0 4px",
            animation: "fadeInUp 0.3s var(--ease-out)",
          }}>
            <AgentActivityIndicator startedAt={thinkingStartedAt} />
          </div>
        )}

        {(sessionLoadError || error) && (
          <div style={{
            padding: 12,
            margin: "8px 0",
            borderRadius: "var(--radius-sm)",
            background: "rgba(248,113,113,0.08)",
            border: "1px solid rgba(248,113,113,0.2)",
            color: "var(--danger)",
            fontSize: 13,
            animation: "fadeIn 0.2s var(--ease-out)",
            fontFamily: "var(--font-mono)",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}>
            <span style={{ flex: 1, minWidth: 0 }}>{sessionLoadError || error}</span>
            {sessionLoadError && (
              <button
                type="button"
                onClick={() => setSessionReloadGeneration((generation) => generation + 1)}
                aria-label="重新加载会话"
                title="重新加载会话"
                style={{
                  flexShrink: 0,
                  minHeight: 30,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  padding: "5px 9px",
                  border: "1px solid rgba(248,113,113,0.35)",
                  borderRadius: 5,
                  background: "var(--bg-workspace)",
                  color: "var(--danger)",
                  cursor: "pointer",
                  fontSize: 12,
                }}
              >
                <RefreshCw size={14} aria-hidden="true" />
                重新加载
              </button>
            )}
          </div>
        )}

        <div ref={messagesEndRef} />
        </div>

        <QueryNavigationRail
          entries={queryIndex?.entries ?? []}
          activeMessageId={activeQueryMessageId}
          loadingMessageId={loadingQueryMessageId}
          onActivate={(entry) => { void activateQuery(entry); }}
        />

        {historyWindowMode === "anchored" && (
          <button
            type="button"
            className="chat-history-return-latest"
            data-has-updates={hasLatestHistoryUpdates}
            data-loading-newer={isLoadingNewerHistory}
            aria-busy={isReturningLatestHistory || undefined}
            aria-label="回到最新消息"
            title="回到最新消息"
            disabled={isReturningLatestHistory}
            onClick={() => { void returnToLatestHistory(); }}
          >
            {isReturningLatestHistory
              ? <LoaderCircle className="chat-history-return-latest__spinner" size={16} aria-hidden="true" />
              : <ArrowDownToLine size={16} aria-hidden="true" />}
          </button>
        )}
      </div>

      {/* Input area */}
      <div className="chat-input-area" style={{
        padding: "var(--chat-input-padding)",
        background: "var(--bg-workspace)",
      }}>
        {isCompatibilityReadOnly && (
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 9,
            padding: "8px 10px",
            border: "1px solid var(--border-default)",
            borderRadius: 6,
            background: "var(--bg-surface)",
            color: compatibilityStatus === "incompatible" ? "var(--danger)" : "var(--text-muted)",
            fontSize: 12,
          }}>
            <span style={{ flex: 1 }}>
              {compatibilityStatus === "incompatible"
                ? compatibilityFailure || sessionSummary?.compatibility?.reason || `Codex ${sessionSummary?.compatibility?.producerVersion ?? "未知版本"} 与当前 ${sessionSummary?.compatibility?.readerVersion ?? "运行时"} 不兼容`
                : `正在使用 Codex ${sessionSummary?.compatibility?.readerVersion ?? "当前版本"} 验证此会话`}
            </span>
          </div>
        )}
        {(sessionSummary?.occupancy === "owned-externally" || isOccupiedRecovery) && (
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 9,
            padding: "8px 10px",
            border: "1px solid var(--border-default)",
            borderRadius: 6,
            background: "var(--bg-surface)",
            color: "var(--text-muted)",
            fontSize: 12,
          }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>
            </svg>
            <span style={{ flex: 1 }}>
              {canForkOccupiedCodexSession(sessionSummary, sessionError)
                ? "此会话仍由原客户端持有，可创建副本继续。"
                : `此会话正在被 ${sessionSummary?.sourceLabel || "原客户端"} 使用，当前只读；原客户端释放后会自动恢复输入。`}
            </span>
            {canForkOccupiedCodexSession(sessionSummary, sessionError) && (
              <button
                type="button"
                onClick={() => void handleForkOccupiedSession()}
                disabled={isForkingSession}
                style={{
                  flexShrink: 0,
                  border: "1px solid var(--border-default)",
                  borderRadius: 5,
                  padding: "5px 9px",
                  background: "var(--bg-workspace)",
                  color: "var(--text-primary)",
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: isForkingSession ? "wait" : "pointer",
                  opacity: isForkingSession ? 0.65 : 1,
                }}
              >
                {isForkingSession ? "正在创建…" : "以副本继续"}
              </button>
            )}
          </div>
        )}
        {/* ── TodoList panel ── */}
        {todos.length > 0 && (
          <div style={{
            marginBottom: 10,
            padding: "8px 12px",
            borderRadius: 10,
            background: "var(--bg-surface)",
            border: "1px solid var(--border-subtle)",
            boxShadow: "var(--shadow-sm)",
          }}>
            <div style={{
              display: "flex", alignItems: "center", gap: 5,
              marginBottom: 6,
              fontSize: 10, fontWeight: 700, color: "var(--text-muted)",
              textTransform: "uppercase" as const, letterSpacing: "0.07em",
            }}>
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
              </svg>
              任务列表
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {(() => {
                const completedTitles = new Set(
                  todos.filter((t) => t.status === "completed").map((t) => t.title.toLowerCase()),
                );
                return todos.map(todo => {
                  const isPending = todo.status === "pending";
                  const isProgress = todo.status === "in-progress";
                  const isDone = todo.status === "completed";
                  const isBlocked =
                    isPending &&
                    (todo.dependsOn ?? []).some((dep) => !completedTitles.has(dep.toLowerCase()));
                  return (
                    <div key={todo.id} style={{
                      display: "flex", alignItems: "center", gap: 8,
                      opacity: isDone ? 0.65 : 1,
                      transition: "opacity 0.3s",
                    }}>
                      {/* Status icon */}
                      <div style={{
                        width: 16, height: 16, borderRadius: "50%", flexShrink: 0,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        background: isDone
                          ? "rgba(52,211,153,0.15)"
                          : isProgress
                          ? "var(--accent-dim)"
                          : isBlocked
                          ? "rgba(239,68,68,0.08)"
                          : "rgba(0,0,0,0.04)",
                        border: isDone
                          ? "1.5px solid rgba(52,211,153,0.6)"
                          : isProgress
                          ? "1.5px solid var(--accent)"
                          : isBlocked
                          ? "1.5px solid rgba(239,68,68,0.5)"
                          : "1.5px solid var(--border-default)",
                      }}>
                        {isDone && (
                          <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="rgba(52,211,153,0.9)" strokeWidth="3" strokeLinecap="round">
                            <path d="M20 6L9 17l-5-5"/>
                          </svg>
                        )}
                        {isProgress && (
                          <div style={{
                            width: 6, height: 6, borderRadius: "50%",
                            background: "var(--accent)",
                            animation: "pulse 1.2s ease-in-out infinite",
                          }}/>
                        )}
                        {isBlocked && (
                          <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="rgba(239,68,68,0.8)" strokeWidth="3" strokeLinecap="round">
                            <path d="M18 6L6 18M6 6l12 12"/>
                          </svg>
                        )}
                        {isPending && !isBlocked && (
                          <div style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--border-default)" }}/>
                        )}
                      </div>
                      {/* Title */}
                      <span style={{
                        fontSize: 12,
                        color: isDone ? "var(--text-muted)" : isBlocked ? "rgba(239,68,68,0.8)" : "var(--text-primary)",
                        textDecoration: isDone ? "line-through" : "none",
                        flex: 1,
                      }}>{todo.title}</span>
                      {/* Blocked chip */}
                      {isBlocked && (
                        <span title={`等待: ${(todo.dependsOn ?? []).join(", ")}`} style={{
                          fontSize: 10, color: "rgba(239,68,68,0.9)",
                          background: "rgba(239,68,68,0.08)",
                          border: "1px solid rgba(239,68,68,0.25)",
                          borderRadius: 8, padding: "1px 6px",
                          flexShrink: 0,
                        }}>等待前置</span>
                      )}
                      {/* Agent chip */}
                      {todo.agentName && (
                        <span style={{
                          fontSize: 10, color: "var(--accent)",
                          background: "var(--accent-dim)",
                          border: "1px solid rgba(79,110,247,0.2)",
                          borderRadius: 8, padding: "1px 6px",
                          flexShrink: 0,
                        }}>@{todo.agentName}</span>
                      )}
                    </div>
                  );
                });
              })()}
            </div>
          </div>
        )}
        {/* Cron task management panel */}
        {cronTasks.length > 0 && (
          <div style={{
            marginBottom: 10,
            borderRadius: 10,
            background: "var(--bg-surface)",
            border: "1px solid rgba(251,191,36,0.25)",
            overflow: "hidden",
          }}>
            {/* Header */}
            <div style={{
              display: "flex", alignItems: "center", gap: 6,
              padding: "6px 12px",
              borderBottom: "1px solid rgba(251,191,36,0.15)",
              background: "rgba(251,191,36,0.06)",
            }}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
              </svg>
              <span style={{ fontSize: 10, fontWeight: 700, color: "#d97706", textTransform: "uppercase" as const, letterSpacing: "0.07em", flex: 1 }}>定时任务</span>
              <button
                onClick={async () => {
                  if (window.agentApi) {
                    await window.agentApi.cronDeleteAll();
                    setCronTasks([]);
                    addMessage({ id: crypto.randomUUID(), role: "assistant", content: "✅ 所有定时任务已删除。", timestamp: Date.now() });
                  }
                }}
                title="删除全部"
                style={{ background: "none", border: "1px solid rgba(251,191,36,0.35)", borderRadius: 6, color: "#d97706", cursor: "pointer", padding: "1px 7px", fontSize: 10 }}
              >
                全部删除
              </button>
            </div>
            {/* Cron task rows */}
            {cronTasks.map((task) => (
              <div key={task.id} style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "7px 12px",
                borderBottom: "1px solid var(--border-subtle)",
                opacity: task.enabled ? 1 : 0.7,
              }}>
                {/* Status dot */}
                <div style={{
                  width: 7, height: 7, borderRadius: "50%", flexShrink: 0,
                  background: task.enabled ? "#22c55e" : "#9ca3af",
                  boxShadow: task.enabled ? "0 0 5px rgba(34,197,94,0.55)" : "none",
                  animation: task.enabled ? "pulse 2s ease-in-out infinite" : "none",
                }} />
                {/* Cron badge */}
                <span style={{
                  fontSize: 10, fontWeight: 700, color: "#d97706",
                  background: "rgba(251,191,36,0.12)",
                  border: "1px solid rgba(251,191,36,0.25)",
                  borderRadius: 6, padding: "1px 6px", flexShrink: 0,
                  fontFamily: "var(--font-mono)",
                }}>
                  {task.cron}
                </span>
                {/* Prompt text */}
                <span style={{ fontSize: 12, color: "var(--text-primary)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {task.label || task.prompt}
                </span>
                {/* ID */}
                <span style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)", flexShrink: 0 }}>
                  {task.id.slice(0, 6)}
                </span>
                {/* Actions */}
                <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                  {/* Pause / Resume */}
                  {task.enabled ? (
                    <button
                      title="暂停"
                      onClick={async () => {
                        if (window.agentApi) {
                          await window.agentApi.cronPause(task.id);
                          const updated = await window.agentApi.cronList();
                          setCronTasks(updated);
                        }
                      }}
                      style={{ background: "none", border: "1px solid var(--border-default)", borderRadius: 6, color: "var(--text-muted)", cursor: "pointer", padding: "2px 7px", fontSize: 11 }}
                      onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = "#d97706"; (e.currentTarget as HTMLButtonElement).style.color = "#d97706"; }}
                      onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--border-default)"; (e.currentTarget as HTMLButtonElement).style.color = "var(--text-muted)"; }}
                    >
                      ⏸
                    </button>
                  ) : (
                    <button
                      title="恢复"
                      onClick={async () => {
                        if (window.agentApi) {
                          await window.agentApi.cronResume(task.id);
                          const updated = await window.agentApi.cronList();
                          setCronTasks(updated);
                        }
                      }}
                      style={{ background: "none", border: "1px solid var(--border-default)", borderRadius: 6, color: "var(--text-muted)", cursor: "pointer", padding: "2px 7px", fontSize: 11 }}
                      onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = "#22c55e"; (e.currentTarget as HTMLButtonElement).style.color = "#22c55e"; }}
                      onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--border-default)"; (e.currentTarget as HTMLButtonElement).style.color = "var(--text-muted)"; }}
                    >
                      ▶
                    </button>
                  )}
                  {/* Delete */}
                  <button
                    title="删除"
                    onClick={async () => {
                      if (window.agentApi) {
                        await window.agentApi.cronDelete(task.id);
                        const updated = await window.agentApi.cronList();
                        setCronTasks(updated);
                      }
                    }}
                    style={{ background: "none", border: "1px solid var(--border-default)", borderRadius: 6, color: "var(--text-muted)", cursor: "pointer", padding: "2px 7px", fontSize: 11 }}
                    onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--danger)"; (e.currentTarget as HTMLButtonElement).style.color = "var(--danger)"; }}
                    onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--border-default)"; (e.currentTarget as HTMLButtonElement).style.color = "var(--text-muted)"; }}
                  >
                    🗑
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        {/* Attached files preview */}
        {attachedFiles.length > 0 && (
          <div style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
            marginBottom: 10,
          }}>
            {attachedFiles.map((file, i) => (
              <div key={i} style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                padding: "3px 10px 3px 8px",
                borderRadius: 20,
                background: "var(--accent-dim)",
                border: "1px solid rgba(79,110,247,0.18)",
                fontSize: 12,
                color: "var(--accent)",
                maxWidth: 220,
              }}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
                </svg>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {file.name}
                </span>
                <button
                  onClick={() => removeAttachedFile(i)}
                  style={{
                    background: "none",
                    border: "none",
                    color: "rgba(79,110,247,0.55)",
                    cursor: "pointer",
                    padding: 0,
                    marginLeft: 2,
                    fontSize: 13,
                    lineHeight: 1,
                    display: "flex",
                  }}
                >✕</button>
              </div>
            ))}
          </div>
        )}

        {/* Pending image previews */}
        {pendingImages.length > 0 && (() => {
          const currentProfile = profiles.find((p) => p.id === activeProfileId);
          const noVision = !isNativeRuntime && (!currentProfile || !isVisionModel(currentProfile.modelId));
          return (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 10 }}>
              {noVision && (
                <div style={{
                  display: "flex", alignItems: "center", gap: 6,
                  padding: "6px 10px", borderRadius: 8,
                  background: "rgba(234,179,8,0.1)", border: "1px solid rgba(234,179,8,0.4)",
                  color: "rgba(202,138,4,1)", fontSize: 12,
                }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                    <line x1="12" y1="9" x2="12" y2="13"/>
                    <line x1="12" y1="17" x2="12.01" y2="17"/>
                  </svg>
                  当前模型（{currentProfile?.modelId ?? "未配置"}）不支持图片，发送前请切换到支持视觉的模型（如 claude-3、gpt-4o）
                </div>
              )}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {pendingImages.map((src, i) => (
                  <div key={i} style={{ position: "relative", display: "inline-block" }}>
                    <button
                      type="button"
                      className="chat-message-image-button pending-image-preview-button"
                      aria-label={`预览待发送图片 ${i + 1}`}
                      onClick={() => setPreviewedMessageImage({ src, alt: `待发送图片 ${i + 1}` })}
                    >
                      <img
                        src={src}
                        alt={`待发送图片 ${i + 1}`}
                        style={{
                          width: 72, height: 72, objectFit: "cover",
                          borderRadius: 8, border: "1.5px solid var(--border-default)",
                          display: "block",
                        }}
                      />
                    </button>
                    <button
                      type="button"
                      aria-label={`删除待发送图片 ${i + 1}`}
                      onClick={() => removePendingImage(i)}
                      style={{
                        position: "absolute", top: -6, right: -6,
                        width: 18, height: 18, borderRadius: "50%",
                        background: "var(--danger, #e53e3e)", border: "none",
                        color: "#fff", fontSize: 11, cursor: "pointer",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        lineHeight: 1, padding: 0,
                      }}
                    >✕</button>
                  </div>
                ))}
              </div>
            </div>
          );
        })()}

        {(goalState.active || goalState.queued.length > 0) && (
          <div className="goal-queue" aria-label="目标队列">
            <div className="goal-queue__header">
              <Target size={14} strokeWidth={1.9} aria-hidden="true" />
              <span>目标</span>
              <span className="goal-queue__count">{goalState.queued.length + (goalState.active ? 1 : 0)}</span>
            </div>
            {goalState.active && (
              <div className="goal-queue__row is-active">
                <span className="goal-queue__state">进行中</span>
                <span className="goal-queue__objective" title={goalState.active.objective}>
                  {goalState.active.objective}
                </span>
                <button
                  type="button"
                  className="goal-queue__action"
                  onClick={() => { void removeGoal(goalState.active!.id); }}
                  title="停止当前目标"
                  aria-label="停止当前目标"
                >
                  <Trash2 size={14} strokeWidth={1.8} aria-hidden="true" />
                </button>
              </div>
            )}
            {goalState.queued.map((goal, index) => (
              <div
                key={goal.id}
                className={`goal-queue__row is-queued${draggedGoalId === goal.id ? " is-dragging" : ""}`}
                draggable
                onDragStart={() => setDraggedGoalId(goal.id)}
                onDragEnd={() => setDraggedGoalId(null)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => { void dropQueuedGoal(goal.id); }}
              >
                <GripVertical className="goal-queue__grip" size={14} strokeWidth={1.8} aria-hidden="true" />
                <span className="goal-queue__state">#{index + 1}</span>
                <span className="goal-queue__objective" title={goal.objective}>{goal.objective}</span>
                <button
                  type="button"
                  className="goal-queue__action"
                  onClick={() => { void removeGoal(goal.id); }}
                  title="移出目标队列"
                  aria-label="移出目标队列"
                >
                  <Trash2 size={14} strokeWidth={1.8} aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Queued messages — shown above input when agent is running */}
        {(() => {
          const queuedMsgs = messages.filter(m => m.isQueued);
          if (queuedMsgs.length === 0) return null;
          return (
            <div className="queued-message-list">
              {queuedMsgs.map((msg) => {
                const chatMsg = msg as import("../stores/agentStore").ChatMessage;
                const isEditing = editingQueuedId === msg.id;
                const preview = chatMsg.content.length > 80
                  ? chatMsg.content.slice(0, 80) + "…"
                  : chatMsg.content;
                return (
                  <div
                    key={msg.id}
                    className={`queued-message-row${draggedQueuedMessageId === msg.id ? " is-dragging" : ""}`}
                    data-queued-message-id={msg.id}
                    onDragOver={(event) => {
                      if (!draggedQueuedMessageId || draggedQueuedMessageId === msg.id) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      if (draggedQueuedMessageId) reorderQueuedMessage(draggedQueuedMessageId, msg.id);
                      setDraggedQueuedMessageId(null);
                    }}
                  >
                    <button
                      type="button"
                      className="queued-message-grip"
                      draggable={!isEditing}
                      aria-label="拖动调整排队顺序"
                      title="拖动调整顺序"
                      onDragStart={(event) => {
                        setDraggedQueuedMessageId(msg.id);
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData("text/plain", msg.id);
                      }}
                      onDragEnd={() => setDraggedQueuedMessageId(null)}
                      onKeyDown={(event) => {
                        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                          event.preventDefault();
                          moveQueuedMessageByKeyboard(msg.id, event.key === "ArrowUp" ? -1 : 1);
                        }
                      }}
                      onPointerDown={(event) => {
                        if (event.pointerType === "mouse" || isEditing) return;
                        queuedPointerDragRef.current = { id: msg.id, pointerId: event.pointerId };
                        event.currentTarget.setPointerCapture(event.pointerId);
                        setDraggedQueuedMessageId(msg.id);
                      }}
                      onPointerMove={(event) => {
                        const drag = queuedPointerDragRef.current;
                        if (!drag || drag.pointerId !== event.pointerId) return;
                        event.preventDefault();
                        const target = document.elementFromPoint(event.clientX, event.clientY)
                          ?.closest<HTMLElement>("[data-queued-message-id]");
                        const targetId = target?.dataset.queuedMessageId;
                        if (targetId && targetId !== drag.id) reorderQueuedMessage(drag.id, targetId);
                      }}
                      onPointerUp={(event) => {
                        if (queuedPointerDragRef.current?.pointerId !== event.pointerId) return;
                        queuedPointerDragRef.current = null;
                        setDraggedQueuedMessageId(null);
                      }}
                      onPointerCancel={() => {
                        queuedPointerDragRef.current = null;
                        setDraggedQueuedMessageId(null);
                      }}
                    >
                      <GripVertical size={15} strokeWidth={1.8} aria-hidden="true" />
                    </button>
                    <div className="queued-message-content">
                      {chatMsg.agentName && (
                        <span className="queued-message-agent">@{chatMsg.agentName}</span>
                      )}
                      {isEditing ? (
                        <input
                          autoFocus
                          className="queued-message-edit-input"
                          value={queuedEditDraft}
                          onChange={(event) => setQueuedEditDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                              event.preventDefault();
                              saveQueuedMessageEdit(msg.id);
                            } else if (event.key === "Escape") {
                              event.preventDefault();
                              cancelQueuedMessageEdit();
                            }
                          }}
                          aria-label="编辑排队消息内容"
                        />
                      ) : (
                        <span className="queued-message-text" title={chatMsg.content}>{preview}</span>
                      )}
                    </div>
                    <div className="queued-message-actions">
                      {canSteerQueuedMessages && (
                        <button
                          type="button"
                          className="queued-message-action queued-message-action--accent"
                          onClick={() => void handleSteer(msg.id)}
                          title="引导到当前对话"
                          aria-label="引导排队消息到当前对话"
                        >
                          <CornerUpRight size={15} strokeWidth={1.8} aria-hidden="true" />
                        </button>
                      )}
                      <button
                        type="button"
                        className="queued-message-action"
                        onClick={() => void copyQueuedMessage(msg.id)}
                        title={copiedQueuedId === msg.id ? "已复制" : "复制"}
                        aria-label="复制排队消息"
                      >
                        {copiedQueuedId === msg.id
                          ? <Check size={15} strokeWidth={1.8} aria-hidden="true" />
                          : <Copy size={15} strokeWidth={1.8} aria-hidden="true" />}
                      </button>
                      <button
                        type="button"
                        className="queued-message-action"
                        onClick={() => isEditing ? saveQueuedMessageEdit(msg.id) : beginQueuedMessageEdit(msg.id)}
                        disabled={isEditing && !queuedEditDraft.trim()}
                        title={isEditing ? "保存" : "编辑"}
                        aria-label={isEditing ? "保存排队消息" : "编辑排队消息"}
                      >
                        {isEditing
                          ? <Check size={15} strokeWidth={1.8} aria-hidden="true" />
                          : <Pencil size={15} strokeWidth={1.8} aria-hidden="true" />}
                      </button>
                      <button
                        type="button"
                        className="queued-message-action queued-message-action--danger"
                        onClick={() => deleteQueuedMessage(msg.id)}
                        title="删除"
                        aria-label="删除排队消息"
                      >
                        <Trash2 size={15} strokeWidth={1.8} aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })()}

        {/* Input box */}
        <div ref={pickerAnchorRef} className="composer-anchor" style={{ position: "relative" }}>

        <div className="composer-shell" style={{
          display: "flex",
          flexDirection: "column",
          gap: 0,
          background: "var(--bg-surface)",
          borderRadius: 14,
          overflow: "visible",
        }}>
          {/* Inner input row */}
          <div className="composer-input-row" style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "var(--composer-row-padding)",
          }}>
          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: "none" }}
            onChange={handleFileAttach}
          />

          {/* Pending agent chips (multiple) */}
          {pendingAgents.length > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0, flexWrap: "nowrap", overflow: "hidden", maxWidth: 300 }}>
              {pendingAgents.map(agent => (
                <div key={agent.id} style={{
                  display: "flex", alignItems: "center", gap: 3,
                  padding: "2px 7px 2px 6px",
                  borderRadius: 20,
                  background: "var(--accent-dim)",
                  border: "1px solid rgba(79,110,247,0.25)",
                  fontSize: 12, color: "var(--accent)",
                  flexShrink: 0, whiteSpace: "nowrap",
                }}>
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <circle cx="12" cy="8" r="4"/><path d="M20 21a8 8 0 1 0-16 0"/>
                  </svg>
                  @{agent.name}
                  <button
                    onClick={() => removePendingAgent(agent.id)}
                    style={{ background: "none", border: "none", color: "rgba(79,110,247,0.55)", cursor: "pointer", padding: 0, lineHeight: 1, fontSize: 12, display: "flex" }}
                  >✕</button>
                </div>
              ))}
            </div>
          )}

          {/* Shared multiline input */}
          <textarea
            className="composer-text-input web-native-composer-textarea"
            ref={inputRef as React.RefObject<HTMLTextAreaElement>}
            rows={3}
            value={input}
            onChange={(event) => handleComposerChange(event.target.value)}
            onBlur={() => setTimeout(() => { setAtQuery(null); setSlashQuery(null); }, 120)}
            onKeyDown={handleComposerKeyDown}
            placeholder={isCompatibilityReadOnly ? (compatibilityStatus === "incompatible" ? "Codex 版本不兼容" : "正在验证会话兼容性") : isReadOnly ? "原客户端使用中，当前只读" : runtimeReady ? (goalMode ? "输入要持续推进的目标" : shouldQueueMessage ? "输入下一条排队消息" : "提出后续修改要求") : "请先在设置中配置 API Key"}
            disabled={!canCompose}
          />

          {/* Shared action toolbar */}
          <div className="web-native-composer-toolbar">
              <div className="web-native-add-wrap">
                <button
                  type="button"
                  className="web-native-add-button"
                  aria-label="添加附件、图片或语音"
                  aria-expanded={addMenuOpen}
                  onClick={() => setAddMenuOpen((open) => !open)}
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                </button>
                {addMenuOpen && (
                  <div className="web-native-add-menu">
                    <button type="button" onClick={() => { setAddMenuOpen(false); fileInputRef.current?.click(); }}>
                      附件 / 图片
                    </button>
                    <button type="button" onClick={() => { setAddMenuOpen(false); handleMicToggle(); }}>
                      语音输入
                    </button>
                  </div>
                )}
              </div>

              <button
                type="button"
                className={`web-native-runtime-status goal-mode-toggle${goalMode ? " is-active" : ""}`}
                aria-pressed={goalMode}
                aria-label={goalMode ? "关闭目标模式" : "开启目标模式"}
                title={goalMode ? "目标模式已开启" : "目标模式"}
                onClick={() => setGoalMode((enabled) => !enabled)}
              >
                <Target size={18} strokeWidth={1.9} aria-hidden="true" />
              </button>

              <div className="web-native-permission-wrap" ref={permissionMenuRef}>
                  <button
                    type="button"
                    className={`web-native-runtime-status web-native-permission-button mode-${permissionMode}`}
                    aria-label={`会话权限：${PERMISSION_OPTIONS.find((option) => option.value === permissionMode)?.label}`}
                    aria-haspopup="menu"
                    aria-expanded={permissionMenuOpen}
                    title={`会话权限：${PERMISSION_OPTIONS.find((option) => option.value === permissionMode)?.label}`}
                    disabled={!viewSessionId || isSavingPermission}
                    onClick={() => setPermissionMenuOpen((open) => !open)}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                      <path d="M12 8v4" /><path d="M12 16h.01" />
                    </svg>
                  </button>
                  {permissionMenuOpen && (
                    <div className="web-native-permission-menu" role="menu" aria-label="会话权限模式">
                      {PERMISSION_OPTIONS.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          role="menuitemradio"
                          aria-checked={permissionMode === option.value}
                          className={permissionMode === option.value ? "is-active" : ""}
                          onClick={() => { void handlePermissionModeChange(option.value); }}
                        >
                          <span className="web-native-permission-check" aria-hidden="true">
                            {permissionMode === option.value ? "✓" : ""}
                          </span>
                          <span className="web-native-permission-copy">
                            <strong>{option.label}</strong>
                            <small>{option.description}</small>
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
              </div>

              {isNativeRuntime && sessionSummary?.controller === "web" && typeof window.agentApi?.handoffSession === "function" && (
                <button
                  type="button"
                  className="web-native-runtime-status"
                  onClick={() => { void handleDesktopHandoff(); }}
                  title="交接到 Desktop"
                >
                  交接到 Desktop
                </button>
              )}

              <div className="web-native-context-control">
                <ContextUsageBar
                  usage={viewSessionId ? contextUsageBySession[viewSessionId] : undefined}
                  contextWindowK={contextWindow}
                  compact
                />
              </div>

              <label className={`web-native-model-control${isNativeRuntime ? " web-native-model-control--native" : ""}`} title="切换模型">
                {isNativeRuntime && isNativeAgentType(composerAgentType) ? (
                  <>
                    <span
                      className="web-native-model-agent"
                      title={`${NATIVE_AGENT_LABELS[composerAgentType]} 会话`}
                    >
                      <AgentBrandIcon agentType={composerAgentType} size={14} />
                      <span className="web-native-model-agent-name">{NATIVE_AGENT_LABELS[composerAgentType]}</span>
                    </span>
                    {nativeModelPickerReady && (
                      <select
                        aria-label="当前模型"
                        title="切换模型"
                        value={selectedNativeModelKey}
                        onChange={(event) => {
                          updateNativePref({
                            model: event.target.value ? nativeModelFromKey(event.target.value) : undefined,
                          });
                        }}
                      >
                        <option value="">默认模型</option>
                        {runtimeModelOptions.map((option) => (
                          <option key={option.key} value={option.key}>{option.label}</option>
                        ))}
                        {profileModelOptions.length > 0 && (
                          <optgroup label="设置里的模型">
                            {profileModelOptions.map((option) => (
                              <option key={option.key} value={option.key}>{option.label}</option>
                            ))}
                          </optgroup>
                        )}
                      </select>
                    )}
                  </>
                ) : (
                  <select
                    aria-label="当前模型"
                    value={activeProfileId}
                    disabled={profiles.length === 0}
                    onChange={(event) => { void switchActiveProfile(event.target.value); }}
                  >
                    {profiles.length === 0 ? (
                      <option value="">未配置模型</option>
                    ) : profiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>{profile.name || profile.modelId}</option>
                    ))}
                  </select>
                )}
              </label>

              {isLocallyRunning ? (
                <button type="button" onClick={handleAbort} className="web-native-stop-button" aria-label="停止生成" title="停止生成">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <rect x="6" y="6" width="12" height="12" rx="2" />
                  </svg>
                </button>
              ) : isNativeRuntime && nativeEffortOptions.length > 0 ? (
                <div className="web-native-effort-wrap" ref={nativeEffortMenuRef}>
                  <button
                    type="button"
                    className="web-native-effort-button"
                    aria-expanded={nativeEffortMenuOpen}
                    aria-label={`推理强度：${activeNativeEffort ? NATIVE_EFFORT_LABELS[activeNativeEffort] : "默认"}`}
                    title={`推理强度：${activeNativeEffort ? NATIVE_EFFORT_LABELS[activeNativeEffort] : "默认"}（点击切换）`}
                    onClick={() => setNativeEffortMenuOpen((open) => !open)}
                  >
                    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M9.5 4.5A3.5 3.5 0 0 0 6 8v1a3 3 0 0 0-2 2.83V14a3 3 0 0 0 3 3h.25A3.75 3.75 0 0 0 11 20.75V3.25A3.75 3.75 0 0 0 9.5 4.5Z" />
                      <path d="M14.5 4.5A3.5 3.5 0 0 1 18 8v1a3 3 0 0 1 2 2.83V14a3 3 0 0 1-3 3h-.25A3.75 3.75 0 0 1 13 20.75V3.25a3.75 3.75 0 0 1 1.5 1.25Z" />
                    </svg>
                  </button>
                  {nativeEffortMenuOpen && (
                    <div className="web-native-effort-menu" role="menu" aria-label="推理强度">
                      <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={!activeNativeEffort}
                        className={!activeNativeEffort ? "is-active" : undefined}
                        onClick={() => {
                          updateNativePref({ reasoningEffort: undefined });
                          setNativeEffortMenuOpen(false);
                        }}
                      >
                        <span className="web-native-effort-check" aria-hidden="true">
                          {!activeNativeEffort ? "✓" : ""}
                        </span>
                        默认
                      </button>
                      {nativeEffortOptions.map((option) => (
                        <button
                          key={option}
                          type="button"
                          role="menuitemradio"
                          aria-checked={activeNativeEffort === option}
                          className={activeNativeEffort === option ? "is-active" : undefined}
                          onClick={() => {
                            updateNativePref({ reasoningEffort: option });
                            setNativeEffortMenuOpen(false);
                          }}
                        >
                          <span className="web-native-effort-check" aria-hidden="true">
                            {activeNativeEffort === option ? "✓" : ""}
                          </span>
                          {NATIVE_EFFORT_LABELS[option]}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : isNativeRuntime ? (
                <span className="web-native-agent-status" role="status" aria-label="Agent 空闲" title="Agent 空闲">
                  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M9.5 4.5A3.5 3.5 0 0 0 6 8v1a3 3 0 0 0-2 2.83V14a3 3 0 0 0 3 3h.25A3.75 3.75 0 0 0 11 20.75V3.25A3.75 3.75 0 0 0 9.5 4.5Z" />
                    <path d="M14.5 4.5A3.5 3.5 0 0 1 18 8v1a3 3 0 0 1 2 2.83V14a3 3 0 0 1-3 3h-.25A3.75 3.75 0 0 1 13 20.75V3.25a3.75 3.75 0 0 1 1.5 1.25Z" />
                  </svg>
                  <span aria-hidden="true" />
                </span>
              ) : (
                <div className="web-native-effort-wrap" ref={effortMenuRef}>
                  <button
                    type="button"
                    className="web-native-effort-button"
                    aria-expanded={effortMenuOpen}
                    aria-label={`推理强度：${EFFORT_LABELS[reasoningEffort]}`}
                    title={`推理强度：${EFFORT_LABELS[reasoningEffort]}（点击切换）`}
                    onClick={() => setEffortMenuOpen((open) => !open)}
                  >
                    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M9.5 4.5A3.5 3.5 0 0 0 6 8v1a3 3 0 0 0-2 2.83V14a3 3 0 0 0 3 3h.25A3.75 3.75 0 0 0 11 20.75V3.25A3.75 3.75 0 0 0 9.5 4.5Z" />
                      <path d="M14.5 4.5A3.5 3.5 0 0 1 18 8v1a3 3 0 0 1 2 2.83V14a3 3 0 0 1-3 3h-.25A3.75 3.75 0 0 1 13 20.75V3.25a3.75 3.75 0 0 1 1.5 1.25Z" />
                    </svg>
                  </button>
                  {effortMenuOpen && (
                    <div className="web-native-effort-menu" role="menu" aria-label="推理强度">
                      {EFFORT_OPTIONS.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          role="menuitemradio"
                          aria-checked={reasoningEffort === option.value}
                          className={reasoningEffort === option.value ? "is-active" : undefined}
                          onClick={() => {
                            setField("reasoningEffort", option.value);
                            void saveToSystem();
                            setEffortMenuOpen(false);
                          }}
                        >
                          <span className="web-native-effort-check" aria-hidden="true">
                            {reasoningEffort === option.value ? "✓" : ""}
                          </span>
                          {option.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <button
                type="button"
                onClick={handleSend}
                disabled={!canCompose || pendingImageReads > 0 || !input.trim()}
                className="web-native-send-button"
                aria-label={shouldQueueMessage ? "排队发送" : "发送"}
                title={shouldQueueMessage ? "排队发送" : "发送"}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 19V5M5 12l7-7 7 7" />
                </svg>
              </button>
          </div>
          </div>{/* end inner input row */}
        </div>{/* end input box */}
        </div>{/* end relative wrapper */}

        {/* Hint */}
        <div className="chat-composer-hint" style={{
          textAlign: "center",
          marginTop: 7,
          fontSize: 11,
          color: "var(--text-muted)",
          letterSpacing: "0.03em",
          opacity: 0.6,
        }}>
          Enter 发送{goalMode ? "目标" : shouldQueueMessage ? "（排队）" : ""} · @智能体（可多选）· /技能 · Shift+Enter 换行{isRecording ? " · 🎤 正在聆听…" : ""}
        </div>
      </div>

      <MessageImageLightbox
        image={previewedMessageImage}
        onClose={() => setPreviewedMessageImage(null)}
      />

      {/* ── Picker overlays rendered via portal to escape overflow:hidden ancestors ── */}
      {pickerRect && atQuery !== null && filteredAgents.length > 0 && createPortal(
        <div style={{
          position: "fixed",
          bottom: window.innerHeight - pickerRect.top + 8,
          left: pickerRect.left,
          width: pickerRect.width,
          background: "var(--bg-surface)",
          border: "1px solid var(--border-default)",
          borderRadius: 10,
          boxShadow: "var(--shadow-md)",
          overflow: "hidden",
          zIndex: 99999,
        }}>
          <div style={{ padding: "6px 10px 4px", fontSize: 10, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase" as const, letterSpacing: "0.06em" }}>智能体</div>
          {filteredAgents.map(agent => (
            <button key={agent.id}
              onMouseDown={(e) => { e.preventDefault(); selectAgent(agent); }}
              style={{ display: "block", width: "100%", textAlign: "left" as const, padding: "8px 12px", border: "none", background: "transparent", cursor: "pointer" }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = "var(--accent-dim)"; }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>@{agent.name}</div>
              {agent.description && <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 1 }}>{agent.description}</div>}
            </button>
          ))}
        </div>,
        document.body
      )}

      {pickerRect && slashQuery !== null && filteredSkills.length > 0 && createPortal(
        <div style={{
          position: "fixed",
          bottom: window.innerHeight - pickerRect.top + 8,
          left: pickerRect.left,
          width: pickerRect.width,
          background: "var(--bg-surface)",
          border: "1px solid var(--border-default)",
          borderRadius: 10,
          boxShadow: "var(--shadow-md)",
          zIndex: 99999,
          display: "flex",
          flexDirection: "column",
          maxHeight: 320,
        }}>
          <div style={{ padding: "6px 10px 4px", fontSize: 10, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase" as const, letterSpacing: "0.06em", flexShrink: 0 }}>
            技能 ({filteredSkills.length})
          </div>
          <div style={{ overflowY: "auto", flex: 1 }}>
            {filteredSkills.map(skill => (
              <button key={skill.name}
                onMouseDown={(e) => { e.preventDefault(); selectSkill(skill); }}
                style={{ display: "block", width: "100%", textAlign: "left" as const, padding: "8px 12px", border: "none", background: "transparent", cursor: "pointer" }}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = "var(--accent-dim)"; }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>/{skill.name}</div>
                {skill.description && <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{skill.description}</div>}
              </button>
            ))}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

function scrollMessageToCenter(
  container: HTMLElement,
  target: HTMLElement,
  behavior: ScrollBehavior = "auto",
): void {
  const containerRect = container.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const top = container.scrollTop
    + targetRect.top
    - containerRect.top
    - Math.max(0, (container.clientHeight - targetRect.height) / 2);
  container.scrollTo({ top: Math.max(0, top), behavior });
}
