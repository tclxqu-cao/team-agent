import { useRef, useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { useAgentStore, type StreamEvent, type CronTask } from "../stores/agentStore";

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
        part.startsWith('`') && part.endsWith('`') && part.length > 2 ? (
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

/** Render inline markdown: `code`, **bold**, *italic* within a single line. */
function renderRichInline(text: string): React.ReactNode {
  // Split by code spans first to avoid formatting inside code
  const codeParts = text.split(/(`[^`\n]+`)/g);
  return codeParts.map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code key={i} style={{ fontFamily: 'var(--font-mono)', fontSize: '0.84em', background: 'rgba(17,24,39,0.06)', padding: '1px 5px', borderRadius: 4, color: 'var(--accent)', border: '1px solid var(--border-subtle)' }}>
          {part.slice(1, -1)}
        </code>
      );
    }
    // Parse **bold** and *italic* in non-code segments
    const tokens = part.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g);
    return tokens.map((tok, j) => {
      if (tok.startsWith('**') && tok.endsWith('**') && tok.length > 4) {
        return <strong key={`${i}-${j}`} style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{tok.slice(2, -2)}</strong>;
      }
      if (tok.startsWith('*') && tok.endsWith('*') && tok.length > 2) {
        return <em key={`${i}-${j}`}>{tok.slice(1, -1)}</em>;
      }
      return <span key={`${i}-${j}`}>{tok}</span>;
    });
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

/** Render assistant message text: supports Markdown tables, `code`, **bold**, *italic*, and newlines. */
function renderAssistantText(text: string): React.ReactNode {
  const lines = text.split('\n');
  const segments: React.ReactNode[] = [];
  let i = 0;
  let segKey = 0;

  while (i < lines.length) {
    // Detect table block: line starts with '|' and next line is separator
    if (lines[i].trimStart().startsWith('|') && i + 1 < lines.length && /^\|[\s\-:|]+\|$/.test(lines[i + 1].trim())) {
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
      while (i < lines.length && !(lines[i].trimStart().startsWith('|') && i + 1 < lines.length && /^\|[\s\-:|]+\|$/.test(lines[i + 1].trim()))) {
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
import ToolCallCard from "./ToolCallCard";
import AskUserCard from "./AskUserCard";
import { widgetRegistry } from "./widgets/index.js";

interface ChatViewProps {
  selectedProjectId?: string | null;
  selectedSessionId?: string | null;
  onSessionCreated?: (sessionId: string) => void | Promise<void>;
  onMessageSent?: (sessionId: string, firstMessage: string) => void | Promise<void>;
  /** Called when a sub-session is created by agent_dispatch, with the parent session ID */
  onSubSessionCreated?: (parentSessionId: string) => void | Promise<void>;
  /** Navigate to a specific session (e.g., click a sub-session link) */
  onSelectSession?: (sessionId: string) => void;
  /** Fired when a sub-agent session starts, completes, or errors — used for toast notifications */
  onSubAgentEvent?: (ev: { type: 'started' | 'completed' | 'failed'; agentName: string; task: string; subSessionId?: string }) => void;
  sessionTitle?: string;
  onOpenSettings?: () => void;
  settingsOpen?: boolean;
}

export default function ChatView({
  selectedProjectId = null,
  selectedSessionId = null,
  onSessionCreated,
  onMessageSent,
  onSubSessionCreated,
  onSelectSession,
  onSubAgentEvent,
  onRunComplete,
  sessionTitle,
  onOpenSettings,
  settingsOpen = false,
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
    clearMessages,
    sessionId,
    todos,
    setTodos,
    cronTasks,
    setCronTasks,
  } = useAgentStore();
  const { isConfigured, profiles, activeProfileId, switchActiveProfile, loadFromSystem } = useSettingsStore();
  const runningSubIdsRef = useRef<Set<string>>(new Set());

  // This view's session is running only when the global running session matches
  const viewSessionId = selectedSessionId || sessionId;
  const isRunning = !!(viewSessionId && (runningSessionId === viewSessionId || runningSubIdsRef.current.has(viewSessionId)));

  // Ensure profiles are loaded even if SettingsPanel was never opened
  useEffect(() => { loadFromSystem(); }, []);

  // Load cron tasks on mount
  useEffect(() => {
    if (!window.agentApi) return;
    void window.agentApi.cronList().then((list) => setCronTasks(list));
  }, []);

  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  /** Base64 data URLs of images to send with the next message */
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pickerAnchorRef = useRef<HTMLDivElement>(null);
  const [pickerRect, setPickerRect] = useState<DOMRect | null>(null);
  const [agents, setAgents] = useState<Array<{id: string; name: string; description: string; isActive?: boolean}>>([]);
  const [skills, setSkills] = useState<Array<{name: string; description: string}>>([]);
  /** List of agents selected via @mention — sent in order */
  const [pendingAgents, setPendingAgents] = useState<Array<{id: string; name: string}>>([]);
  const [atQuery, setAtQuery] = useState<string | null>(null);
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  /** IDs of assistant messages that are manually expanded past the preview limit */
  const [expandedMessages, setExpandedMessages] = useState<Set<string>>(new Set());
  const [thinkingText, setThinkingText] = useState("");
  /** Tracks what the agent is currently doing: thinking, waiting for tools, or idle */
  const [agentActivity, setAgentActivity] = useState<"idle" | "thinking" | "tools">("idle");
  // Track which session the current agent run belongs to
  const runningSessionRef = useRef<string | null>(null);
  // Track whether the user aborted the current run (skip queue processing)
  const abortRef = useRef(false);
  // Always-current refs for selectedSessionId and sessionId — used inside event
  // handlers that are captured in closures and may outlive React renders.
  const selectedSessionIdRef = useRef<string | null>(selectedSessionId ?? null);
  const sessionIdRef = useRef<string | null>(null);
  useEffect(() => { selectedSessionIdRef.current = selectedSessionId ?? null; }, [selectedSessionId]);
  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);

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
    { name: "compact", description: "主动压缩当前会话上下文，并在下轮重新注入环境" },
    { name: "compress", description: "同 /compact，主动压缩当前会话上下文" },
    { name: "压缩", description: "同 /compact，主动压缩当前会话上下文" },
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

  const handleFileAttach = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) {
      setAttachedFiles((prev) => [...prev, ...files]);
    }
    e.target.value = "";
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

  /** Screenshot button: read image from clipboard */
  const handleScreenshot = async () => {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const imgType = item.types.find((t) => t.startsWith("image/"));
        if (imgType) {
          const blob = await item.getType(imgType);
          addPendingImage(await blobToDataUrl(blob));
          break;
        }
      }
    } catch {
      // Permission denied or no image in clipboard — silently ignore
    }
  };

  // Global paste handler: intercept image pastes into the chat input
  useEffect(() => {
    const handlePaste = async (e: ClipboardEvent) => {
      if (!e.clipboardData) return;
      const imageItem = Array.from(e.clipboardData.items).find((it) => it.type.startsWith("image/"));
      if (!imageItem) return;
      e.preventDefault();
      const file = imageItem.getAsFile();
      if (file) addPendingImage(await blobToDataUrl(file));
    };
    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profiles, activeProfileId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
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
    const loadSelectedSession = async () => {
      if (!window.agentApi) return;
      // Capture at call time — used to detect stale responses from fast session switching.
      const targetSid = selectedSessionId;
      if (!targetSid) {
        clearMessages();
        setError(null);
        setSessionId("");
        return;
      }
      // Don't reload from DB while agent is streaming FOR THIS SESSION — messages are in-memory.
      // But only skip if the store already has this session loaded; if the user navigated away
      // and back, sessionId won't match and we must reload.
      if (runningSessionRef.current === targetSid && sessionId === targetSid) return;

      setError(null);
      try {
        const detail = await window.agentApi.getSession(targetSid) as {
          messages?: Array<{
            role?: string;
            content?: string;
            toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
            toolCallId?: string;
            name?: string;
          }>;
          events?: Array<{
            type?: string;
            result?: { toolCallId?: string; content?: string; isError?: boolean };
          }>;
        } | null;
        const persisted = detail?.messages ?? [];

        // Build a fallback map of tool results from persisted events.
        // Events are written to DB *before* the corresponding message rows,
        // so when the user switches away mid-run the tool_result message may
        // be missing while the event is already persisted.
        const eventToolResults = new Map<string, { content: string; isError?: boolean }>();
        for (const evt of detail?.events ?? []) {
          if (evt.type === "tool_result" && evt.result?.toolCallId) {
            eventToolResults.set(evt.result.toolCallId, {
              content: evt.result.content ?? "",
              isError: evt.result.isError,
            });
          }
        }

        // Build messages, merging tool results back into assistant toolCalls
        const rawMessages = persisted
          .filter((m) => (m.role === "user" || m.role === "assistant" || m.role === "tool") && m.name !== "__interrupt__")
          .map((m) => {
            // Convert compaction checkpoint to a display banner
            if (m.name === "__compaction_checkpoint__") {
              let summary = "";
              try { summary = (JSON.parse(m.content ?? "{}") as { summary?: string }).summary ?? ""; } catch { /* ignore */ }
              return {
                id: crypto.randomUUID(),
                role: "user" as const,
                content: summary,
                name: m.name,
                isCompactionSummary: true,
                timestamp: Date.now(),
              };
            }
            return {
              id: crypto.randomUUID(),
              role: m.role as "user" | "assistant" | "tool",
              content: m.content ?? "",
              toolCalls: m.toolCalls && m.toolCalls.length > 0 ? m.toolCalls : undefined,
              toolCallId: m.toolCallId,
              name: m.name,
              timestamp: Date.now(),
            };
          });

        // Merge tool results into assistant toolCalls.result
        // Priority: message-level result > event-level result (fallback)
        const restored = rawMessages
          .filter((m) => m.role !== "tool")
          .map((m) => {
            // Compaction banner — keep as-is
            if ((m as { isCompactionSummary?: boolean }).isCompactionSummary) return m;
            if (m.role === "assistant" && m.toolCalls?.length) {
              const enriched = m.toolCalls.map((tc) => {
                // 1. Try to find a tool result in persisted messages
                const resultMsg = rawMessages.find(
                  (r) => r.role === "tool" && r.toolCallId === tc.id
                );
                if (resultMsg) return { ...tc, result: resultMsg.content };
                // 2. Fallback: recover from persisted events (tool_result
                //    event is written to DB before the message row, so it
                //    survives a session switch mid-run)
                const evtResult = eventToolResults.get(tc.id);
                if (evtResult) return { ...tc, result: evtResult.content, isError: evtResult.isError };
                return tc;
              });
              return { ...m, toolCalls: enriched };
            }
            // For user messages, name field stores @agent label (skip checkpoint marker)
            if (m.role === "user" && m.name && m.name !== "__compaction_checkpoint__") {
              return { ...m, agentName: m.name };
            }
            return m;
          });
        // Stale check: user may have switched sessions while we were awaiting getSession()
        if (selectedSessionId !== targetSid) return;
        setMessages(restored);
        setSessionId(targetSid);

        // Infer agent activity phase from restored messages.
        // If the last restored message has toolCalls without results, the agent
        // is still executing tools — show "工具执行中" rather than "思考中".
        const lastMsg = restored[restored.length - 1];
        if (lastMsg?.role === "assistant" && lastMsg.toolCalls?.length) {
          const allDone = lastMsg.toolCalls.every(tc => tc.result);
          setAgentActivity(allDone ? "thinking" : "tools");
        } else {
          setAgentActivity("idle");
        }
      } catch {
        if (selectedSessionId === targetSid) clearMessages();
      }
    };

    void loadSelectedSession();
  }, [clearMessages, selectedSessionId, setMessages, setSessionId]);

  const handleEvent = (event: StreamEvent) => {
    // Route by _sid using always-current refs, not stale closure values.
    const viewedSid = selectedSessionIdRef.current || sessionIdRef.current;
    if (event._sid && event._sid !== viewedSid) return;
    switch (event.type) {
      case "text_chunk":
        if (event.text) {
          appendText(event.text);
          setThinkingText("");
          setAgentActivity("thinking");
        }
        break;
      case "tool_call":
        setThinkingText("");
        setAgentActivity("tools");
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
          });
        }
        break;
      case "tool_result":
        if (event.result) {
          updateToolResult(event.result.toolCallId, event.result.content, event.result.isError);
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
        });
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
          updateSubAgentProgress(event.subSessionId, event.text);
        }
        break;
      case "compacted":
        addMessage({
          id: crypto.randomUUID(),
          role: "assistant",
          content: event.summary ?? "",
          isCompactionSummary: true,
          timestamp: Date.now(),
        });
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
        const existingIdx = useAgentStore.getState().messages.findIndex(
          (m) => m.widget?.widgetId === widgetMsg.widgetId,
        );
        if (existingIdx >= 0) {
          const existingMsg = useAgentStore.getState().messages[existingIdx];
          updateMessage(existingMsg.id, (m) => ({
            ...m,
            widget: widgetMsg,
          }));
        } else {
          addMessage({
            id: crypto.randomUUID(),
            role: "assistant",
            content: "",
            widget: widgetMsg,
            timestamp: Date.now(),
          });
        }
        break;
      }
      case "ask_user":
        addMessage({
          id: crypto.randomUUID(),
          role: "assistant",
          content: "",
          askUser: {
            questionId: event.questionId ?? "",
            question: event.question ?? "",
            options: event.options,
            multiSelect: event.multiSelect,
          },
          timestamp: Date.now(),
        });
        break;
      case "text_done": break;
      case "thinking":
        if (event.message) {
          setThinkingText(prev => prev + (prev ? "\n" : "") + event.message);
          setAgentActivity("thinking");
        }
        break;
      case "done":
        // Only clear running state here if no queued messages — otherwise
        // startRun's finally block will chain the next run seamlessly.
        if (!useAgentStore.getState().messages.some(m => m.isQueued)) {
          setRunningSession(null);
        }
        setThinkingText("");
        setAgentActivity("idle");
        break;
      case "error":
        setError(event.message ?? "Unknown error");
        setRunningSession(null);
        setAgentActivity("idle");
        break;
    }
  };

  const handleAbort = () => {
    abortRef.current = true;
    if (window.agentApi) {
      window.agentApi.abort();
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
      await window.agentApi.steer(msg.content, targetSessionId, msg.agentName);
      updateMessage(msgId, (m) => ({ ...m, isQueued: false, isSteered: true }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "引导失败");
    }
  };

  /**
   * Unified run launcher — starts an agent run and processes the message
   * queue in the finally block.  When the current run finishes, the next
   * queued message (if any and the user didn't abort) is automatically
   * started as a new run.
   */
  const startRun = async (
    message: { content: string; agentName?: string; images?: string[] },
    targetSessionId: string,
    agentIds?: string[],
  ) => {
    abortRef.current = false;
    runningSessionRef.current = targetSessionId;
    setRunningSession(targetSessionId);
    setThinkingText("");
    try {
      if (window.agentApi) {
        await window.agentApi.run(
          message.content,
          targetSessionId,
          agentIds,
          message.agentName,
          message.images,
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Agent run failed");
    } finally {
      // Check for next queued message (skip if user aborted)
      const nextQueued = !abortRef.current
        ? useAgentStore.getState().messages.find(m => m.isQueued)
        : undefined;
      if (nextQueued) {
        updateMessage(nextQueued.id, (m) => ({ ...m, isQueued: false }));
        if (onRunComplete) void onRunComplete(selectedProjectId);
        void startRun(nextQueued, targetSessionId);
      } else {
        runningSessionRef.current = null;
        setRunningSession(null);
        if (onRunComplete) void onRunComplete(selectedProjectId);
      }
    }
  };

  const handleSend = async () => {
    if (!input.trim() || !isConfigured) return;

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

    // ── /skill-name command: transform to natural language ────────────────
    const finalMsg = (() => {
      const slashSkillMatch = input.trim().match(/^\/([\w-]+)\s*(.*)$/);
      if (slashSkillMatch) {
        const skillName = slashSkillMatch[1];
        const rest = slashSkillMatch[2].trim();
        const found = skills.find(s => s.name === skillName);
        if (found) {
          if (rest) {
            // /skill-name payload → send payload with skill context
            return `请使用「${found.name}」技能协助完成：${rest}（技能说明：${found.description}）`;
          }
          return `请使用「${found.name}」技能协助：${found.description}`;
        }
      }
      return input.trim();
    })();
    // ──────────────────────────────────────────────────────────────────────

    const agentNamesLabel = pendingAgents.length > 0
      ? pendingAgents.map(a => a.name).join(", ")
      : undefined;
    const imagesToSend = pendingImages.length > 0 ? [...pendingImages] : undefined;
    const agentIdsToSend = pendingAgents.map(a => a.id);
    setPendingAgents([]);
    setInput("");
    setAttachedFiles([]);
    setPendingImages([]);

    // ── Queue message if agent is running ──────────────────────────────────
    if (isRunning) {
      addMessage({
        id: crypto.randomUUID(),
        role: "user",
        content: finalMsg,
        timestamp: Date.now(),
        agentName: agentNamesLabel,
        images: imagesToSend,
        isQueued: true,
      });
      return;
    }

    // ── Normal send flow ───────────────────────────────────────────────────
    setThinkingText("");  // clear any previous thinking from prior turns
    setTodos([]);  // clear previous run's todos on new message

    addMessage({
      id: crypto.randomUUID(),
      role: "user",
      content: finalMsg,
      timestamp: Date.now(),
      agentName: agentNamesLabel,
      images: imagesToSend,
    });

    try {
      let targetSessionId = selectedSessionId || sessionId;

      if (!targetSessionId && window.agentApi) {
        const created = await window.agentApi.createSession(
          finalMsg.slice(0, 60) || "New Session",
          selectedProjectId || undefined,
        ) as { id: string };
        targetSessionId = created.id;
        setSessionId(created.id);
        // Mark running BEFORE onSessionCreated so loadSelectedSession guard fires
        // and doesn't clear locally-added user message
        runningSessionRef.current = targetSessionId;
        setRunningSession(targetSessionId);
        if (onSessionCreated) {
          await onSessionCreated(created.id);
        }
      }

      if (!targetSessionId) {
        targetSessionId = crypto.randomUUID();
        setSessionId(targetSessionId);
      }

      // Notify immediately so sidebar title updates before agent finishes
      if (onMessageSent && targetSessionId) {
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

  return (
    <div style={{
      display: "flex",
      flexDirection: "column",
      height: "100%",
      maxWidth: 880,
      margin: "0 auto",
    }}>
      {/* ── Top bar: title + settings ── */}
      <div style={{
        display: "flex",
        alignItems: "center",
        padding: "0 20px",
        height: 52,
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
        {onOpenSettings && (
          <button
            onClick={onOpenSettings}
            title="设置"
            onMouseEnter={e => {
              (e.currentTarget as HTMLButtonElement).style.background = "var(--bg-deep)";
              (e.currentTarget as HTMLButtonElement).style.color = "var(--text-primary)";
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLButtonElement).style.background = "transparent";
              (e.currentTarget as HTMLButtonElement).style.color = settingsOpen ? "var(--accent)" : "var(--text-muted)";
            }}
            style={{
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 32,
              height: 32,
              borderRadius: 8,
              border: "none",
              background: "transparent",
              color: settingsOpen ? "var(--accent)" : "var(--text-muted)",
              cursor: "pointer",
              transition: "background 0.15s, color 0.15s",
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
          </button>
        )}
      </div>

      {/* Messages area */}
      <div style={{
        flex: 1,
        overflow: "auto",
        padding: "24px 40px 16px",
      }}>

        {messages.length === 0 && (
          <div style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            height: "100%",
            gap: 16,
          }}>
            <div style={{
              width: 64,
              height: 64,
              borderRadius: "50%",
              background: "linear-gradient(135deg, var(--accent-dim) 0%, transparent 100%)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 28,
              color: "var(--accent)",
              marginBottom: 8,
            }}>
              ◇
            </div>
            <h2 style={{
              fontFamily: "var(--font-display)",
              fontSize: 26,
              color: "var(--text-primary)",
              fontWeight: 400,
              letterSpacing: "-0.02em",
            }}>
              智能助手
            </h2>
            <p style={{
              fontSize: 14,
              color: "var(--text-muted)",
              textAlign: "center",
              lineHeight: 1.7,
            }}>
              {isConfigured
                ? "有什么我能帮你的？工具、记忆和技能随时待命。"
                : "请先在设置中配置 API Key 以开始使用。"}
            </p>
          </div>
        )}

        {messages.map((msg, i) => {
          const chatMsg = msg as import("../stores/agentStore").ChatMessage;
          // Skip queued messages — they are rendered in the queue bar above the input
          if (chatMsg.isQueued) return null;
          const isUser = msg.role === "user";

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

          // Show "思考中" label above the last streaming assistant bubble
          const isLastAssistant = !isUser && i === messages.length - 1;
          const showThinking = isRunning && isLastAssistant;

          // Use larger bottom margin when the NEXT message switches role (turn boundary).
          const nextMsg = messages[i + 1] as import("../stores/agentStore").ChatMessage | undefined;
          const isTurnBoundary = nextMsg && nextMsg.role !== msg.role && !nextMsg.isCompactionSummary;

          return (
          <div key={msg.id} style={{ marginBottom: isTurnBoundary ? 16 : 3 }}>
            {/* Thinking block — single display, only for the last streaming assistant */}
            {showThinking && (
              <div style={{
                display: "flex",
                paddingLeft: 40, marginBottom: 4,
              }}>
                <div style={{
                  fontSize: 11, color: "var(--text-muted)", fontStyle: "italic",
                  padding: thinkingText ? "6px 12px" : "4px 0",
                  borderRadius: 8,
                  background: thinkingText ? "var(--bg-deep)" : "transparent",
                  border: thinkingText ? "1px solid var(--border-subtle)" : "none",
                  whiteSpace: "pre-wrap", wordBreak: "break-word",
                  lineHeight: 1.6, maxHeight: 160, overflow: "auto",
                  maxWidth: "76%",
                }}>
                  {thinkingText ? (
                    <>
                      <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 4, opacity: 0.6 }}>
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v12a2.5 2.5 0 0 1-5 0v-12A2.5 2.5 0 0 1 9.5 2z"/><path d="M9.5 2A2.5 2.5 0 0 0 7 4.5v12a2.5 2.5 0 0 0 5 0v-12A2.5 2.5 0 0 0 9.5 2z"/><path d="M4.5 8H7"/><path d="M12 8h2.5"/><path d="M4 14h2.5"/><path d="M12 14h2.5"/><path d="M4 11h16"/><path d="M12 11h2.5"/></svg>
                        <span style={{ fontWeight: 600 }}>思考过程</span>
                      </div>
                      {thinkingText}
                    </>
                  ) : (
                    <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                      {agentActivity === "tools" ? "工具执行中" : "思考中"}
                      {[0, 1, 2].map((i) => (
                        <span key={i} style={{
                          width: 4, height: 4, borderRadius: "50%",
                          background: "var(--accent)", display: "inline-block",
                          animation: "wave 1.1s ease-in-out infinite",
                          animationDelay: `${i * 0.16}s`,
                        }} />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
            {/* Main message row */}
          <div
            style={{
              display: "flex",
              flexDirection: isUser ? "row-reverse" : "row",
              alignItems: "flex-start",
              gap: 10,
              animation: `fadeInUp 0.3s var(--ease-out) both`,
            }}
          >
            {/* Avatar */}
            {isUser ? (
              <div style={{
                width: 30,
                height: 30,
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
              <div style={{
                width: 30,
                height: 30,
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
            <div style={{ maxWidth: "76%", display: "flex", flexDirection: "column", gap: 4, alignItems: isUser ? "flex-end" : "flex-start", minWidth: 0 }}>
              <div style={{
                // Tool-call-only messages: no bubble wrapper — cards render inline
                padding: (msg.content || (isUser && chatMsg.images?.length)) ? (isUser ? "10px 14px" : "11px 15px") : 0,
                borderRadius: isUser
                  ? "14px 4px 14px 14px"
                  : "4px 14px 14px 14px",
                background: (msg.content || (isUser && chatMsg.images?.length)) ? (isUser ? "rgba(79, 110, 247, 0.08)" : "var(--bg-surface)") : "transparent",
                border: (msg.content || (isUser && chatMsg.images?.length)) ? (isUser ? "1px solid rgba(79, 110, 247, 0.18)" : "1px solid var(--border-subtle)") : "none",
                boxShadow: (msg.content || (isUser && chatMsg.images?.length)) ? (isUser ? "none" : "var(--shadow-sm)") : "none",
                fontSize: 14,
                lineHeight: 1.75,
                color: "var(--text-primary)",
                letterSpacing: "0.01em",
              }}>
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
                ) : msg.role === "assistant" && msg.content ? (() => {
                  const COLLAPSE_THRESHOLD = 500;
                  const isLong = msg.content.length > COLLAPSE_THRESHOLD;
                  const isExpanded = expandedMessages.has(msg.id);
                  const displayed = isLong && !isExpanded
                    ? msg.content.slice(0, COLLAPSE_THRESHOLD)
                    : msg.content;
                  return (
                    <div>
                      <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", position: "relative" }}>
                        {isUser ? displayed : renderAssistantText(displayed)}
                        {isLong && !isExpanded && (
                          // Fade-out gradient at bottom
                          <div style={{
                            position: "absolute",
                            bottom: 0, left: 0, right: 0,
                            height: 40,
                            background: isUser
                              ? "linear-gradient(transparent, rgba(232, 236, 254, 0.95))"
                              : "linear-gradient(transparent, var(--bg-surface))",
                            pointerEvents: "none",
                          }}/>
                        )}
                      </div>
                      {isLong && (
                        <button
                          onClick={() => setExpandedMessages(prev => {
                            const next = new Set(prev);
                            if (isExpanded) next.delete(msg.id); else next.add(msg.id);
                            return next;
                          })}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 4,
                            marginTop: 6,
                            padding: "3px 10px",
                            borderRadius: 20,
                            border: "1px solid var(--border-default)",
                            background: "var(--bg-deep)",
                            color: "var(--text-muted)",
                            fontSize: 12,
                            cursor: "pointer",
                            fontFamily: "var(--font-body)",
                          }}
                          onMouseEnter={e => {
                            (e.currentTarget as HTMLButtonElement).style.background = "var(--accent-dim)";
                            (e.currentTarget as HTMLButtonElement).style.color = "var(--accent)";
                            (e.currentTarget as HTMLButtonElement).style.borderColor = "rgba(79,110,247,0.3)";
                          }}
                          onMouseLeave={e => {
                            (e.currentTarget as HTMLButtonElement).style.background = "var(--bg-deep)";
                            (e.currentTarget as HTMLButtonElement).style.color = "var(--text-muted)";
                            (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--border-default)";
                          }}
                        >
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" style={{ transform: isExpanded ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}>
                            <path d="M6 9l6 6 6-6"/>
                          </svg>
                          {isExpanded ? "收起" : `展开全文（还有 ${msg.content.length - COLLAPSE_THRESHOLD} 字）`}
                        </button>
                      )}
                    </div>
                  );
                })() : (
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
                      <img
                        key={idx}
                        src={src}
                        alt={`attachment-${idx}`}
                        style={{
                          maxWidth: 220, maxHeight: 180, objectFit: "cover",
                          borderRadius: 6, border: "1px solid var(--border-subtle)",
                          display: "block", cursor: "zoom-in",
                        }}
                        onClick={() => window.open(src, "_blank")}
                      />
                    ))}
                  </div>
                )}
                {msg.toolCalls?.map((tc, tcIdx) => {
                  // For write_file: find the most recent read_file result for the same path
                  // so we can compute and show a diff between before/after.
                  let beforeContent: string | undefined;
                  if (tc.name === "write_file" && tc.arguments.file_path) {
                    const writePath = tc.arguments.file_path as string;
                    outer: for (let mi = i; mi >= 0; mi--) {
                      const scanMsg = messages[mi];
                      const tcs = scanMsg.toolCalls;
                      if (!tcs) continue;
                      const start = mi === i ? tcIdx - 1 : tcs.length - 1;
                      for (let ti = start; ti >= 0; ti--) {
                        const prev = tcs[ti];
                        if (prev.name === "read_file" && prev.arguments.file_path === writePath && prev.result && !prev.isError) {
                          beforeContent = prev.result;
                          break outer;
                        }
                      }
                    }
                  }
                  return <ToolCallCard key={tc.id} toolCall={tc} beforeContent={beforeContent} onSelectSession={onSelectSession} />;
                })}
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
                      const tcs = messages[mi].toolCalls ?? [];
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
                      {entries.map(e => (
                        <span key={e.path} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, fontFamily: "var(--font-mono)", background: "var(--bg-surface)", border: "1px solid var(--border-subtle)", borderRadius: 5, padding: "2px 8px" }}>
                          <span style={{ color: "var(--text-secondary)", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={e.path}>
                            {e.path.replace(/\\/g, "/").split("/").pop()}
                          </span>
                          {e.added > 0 && <span style={{ color: "var(--success)", fontWeight: 600 }}>+{e.added}</span>}
                          {e.removed > 0 && <span style={{ color: "var(--danger)", fontWeight: 600 }}>−{e.removed}</span>}
                          {e.added === 0 && e.removed === 0 && <span style={{ color: "var(--text-muted)" }}>{e.lines}行</span>}
                        </span>
                      ))}
                    </div>
                  );
                })()}
              </div>
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
                      <button
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
                      </button>
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

        {/* Thinking indicator (no assistant reply yet) */}
        {isRunning && messages.length > 0 && messages[messages.length - 1].role === "user" && !messages[messages.length - 1].isQueued && (
          <div style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 10,
            padding: "4px 0 4px",
            animation: "fadeInUp 0.3s var(--ease-out)",
          }}>
            {/* Robot avatar */}
            <div style={{
              width: 30, height: 30, borderRadius: "50%", flexShrink: 0,
              display: "flex", alignItems: "center", justifyContent: "center",
              background: "var(--bg-deep)",
              color: "var(--text-muted)",
              border: "1px solid var(--border-subtle)",
            }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="10" rx="2"/>
                <path d="M12 11V7"/>
                <circle cx="12" cy="5" r="2"/>
                <circle cx="8" cy="16" r="1" fill="currentColor" stroke="none"/>
                <circle cx="16" cy="16" r="1" fill="currentColor" stroke="none"/>
                <path d="M8 20h8"/>
              </svg>
            </div>
            <div style={{
              padding: "9px 14px",
              borderRadius: "4px 14px 14px 14px",
              background: "var(--bg-surface)",
              border: "1px solid var(--border-subtle)",
              boxShadow: "var(--shadow-sm)",
              display: "flex", alignItems: "center", gap: 7,
              fontSize: 13, color: "var(--text-muted)", fontStyle: "italic",
            }}>
              {agentActivity === "tools" ? "工具执行中" : "思考中"}
              {[0, 1, 2].map((i) => (
                <span key={i} style={{
                  width: 4, height: 4, borderRadius: "50%",
                  background: "var(--accent)",
                  display: "inline-block",
                  animation: "pulse-glow 1.2s ease-in-out infinite",
                  animationDelay: `${i * 0.2}s`,
                  opacity: 0.8,
                }} />
              ))}
            </div>
          </div>
        )}

        {error && (
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
          }}>
            {error}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div style={{
        padding: "12px 24px 18px",
        background: "var(--bg-deepest)",
        borderTop: "1px solid var(--border-subtle)",
      }}>
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
          const noVision = !currentProfile || !isVisionModel(currentProfile.modelId);
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
                    <img
                      src={src}
                      alt={`image-${i}`}
                      style={{
                        width: 72, height: 72, objectFit: "cover",
                        borderRadius: 8, border: "1.5px solid var(--border-default)",
                        display: "block",
                      }}
                    />
                    <button
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

        {/* Queued messages bar — shown above input when agent is running */}
        {(() => {
          const queuedMsgs = messages.filter(m => m.isQueued);
          if (queuedMsgs.length === 0) return null;
          return (
            <div style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
              marginBottom: 8,
              padding: "8px 12px",
              borderRadius: 12,
              background: "var(--bg-deep)",
              border: "1px solid var(--border-subtle)",
            }}>
              <div style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: 11,
                fontWeight: 600,
                color: "var(--text-muted)",
                letterSpacing: "0.03em",
              }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/>
                </svg>
                排队消息（{queuedMsgs.length}）
              </div>
              {queuedMsgs.map((msg) => {
                const chatMsg = msg as import("../stores/agentStore").ChatMessage;
                const preview = chatMsg.content.length > 80
                  ? chatMsg.content.slice(0, 80) + "…"
                  : chatMsg.content;
                return (
                  <div key={msg.id} style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "5px 8px",
                    borderRadius: 8,
                    background: "var(--bg-surface)",
                    border: "1px solid var(--border-subtle)",
                  }}>
                    <span style={{
                      flex: 1,
                      fontSize: 13,
                      color: "var(--text-primary)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      minWidth: 0,
                    }}>
                      {chatMsg.agentName && (
                        <span style={{
                          fontSize: 10, fontWeight: 700, color: "var(--accent)",
                          background: "var(--accent-dim)", borderRadius: 10,
                          padding: "1px 5px", marginRight: 5, verticalAlign: "middle",
                        }}>@{chatMsg.agentName}</span>
                      )}
                      {preview}
                    </span>
                    <button
                      onClick={() => void handleSteer(msg.id)}
                      title="将此消息引导到当前对话"
                      style={{
                        display: "inline-flex", alignItems: "center", gap: 3,
                        fontSize: 11, fontWeight: 600,
                        color: "var(--accent)",
                        padding: "3px 10px", borderRadius: 20,
                        border: "1px solid rgba(79,110,247,0.3)",
                        background: "var(--accent-dim)",
                        cursor: "pointer",
                        transition: "all 0.15s",
                        fontFamily: "var(--font-body)",
                        whiteSpace: "nowrap",
                        flexShrink: 0,
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
                    </button>
                  </div>
                );
              })}
            </div>
          );
        })()}

        {/* Input box */}
        <div ref={pickerAnchorRef} style={{ position: "relative" }}>

        <div style={{
          display: "flex",
          flexDirection: "column",
          gap: 0,
          background: "var(--bg-surface)",
          borderRadius: 14,
          border: "1.5px solid var(--border-default)",
          boxShadow: "var(--shadow-sm)",
          overflow: "hidden",
        }}>
          {/* Model selector bar (shown only when profiles exist), grouped by provider */}
          {profiles.length > 0 && (() => {
            // Build ordered groups: preserve first-appearance order of providers
            const providerOrder: string[] = [];
            const groups: Record<string, typeof profiles> = {};
            for (const p of profiles) {
              if (!groups[p.provider]) {
                providerOrder.push(p.provider);
                groups[p.provider] = [];
              }
              groups[p.provider].push(p);
            }
            const PROVIDER_LABELS: Record<string, string> = {
              anthropic: "Anthropic",
              openai: "OpenAI",
              deepseek: "DeepSeek",
            };
            return (
              <div style={{
                display: "flex",
                alignItems: "center",
                gap: 0,
                padding: "5px 10px 4px",
                borderBottom: "1px solid var(--border-subtle)",
                overflowX: "auto",
                scrollbarWidth: "none",
              }}>
                {providerOrder.map((provider, gi) => (
                  <div key={provider} style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                    paddingLeft: gi > 0 ? 10 : 0,
                    marginLeft: gi > 0 ? 8 : 0,
                    borderLeft: gi > 0 ? "1px solid var(--border-subtle)" : "none",
                    flexShrink: 0,
                  }}>
                    <span style={{
                      fontSize: 10,
                      color: "var(--text-muted)",
                      opacity: 0.6,
                      flexShrink: 0,
                      letterSpacing: "0.03em",
                      textTransform: "uppercase",
                      fontWeight: 500,
                    }}>
                      {PROVIDER_LABELS[provider] ?? provider}
                    </span>
                    {groups[provider].map((p) => {
                      const isActive = p.id === activeProfileId;
                      return (
                        <button
                          key={p.id}
                          onClick={() => switchActiveProfile(p.id)}
                          title={`${p.provider} · ${p.modelId}`}
                          style={{
                            padding: "3px 10px",
                            borderRadius: 20,
                            border: isActive
                              ? "1px solid var(--accent)"
                              : "1px solid var(--border-subtle)",
                            background: isActive ? "var(--accent-dim)" : "transparent",
                            color: isActive ? "var(--accent)" : "var(--text-muted)",
                            fontSize: 12,
                            fontWeight: isActive ? 600 : 400,
                            cursor: "pointer",
                            whiteSpace: "nowrap",
                            transition: "all 0.15s",
                            flexShrink: 0,
                          }}
                        >
                          {p.name || p.modelId}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            );
          })()}

          {/* Inner input row */}
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 6px 6px 12px",
          }}>
          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: "none" }}
            onChange={handleFileAttach}
          />

          {/* Attach button */}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={!isConfigured || isRunning}
            title="添加附件"
            onMouseEnter={e => {
              if (isConfigured && !isRunning) {
                (e.currentTarget as HTMLButtonElement).style.background = "var(--accent-dim)";
                (e.currentTarget as HTMLButtonElement).style.color = "var(--accent)";
              }
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLButtonElement).style.background = "transparent";
              (e.currentTarget as HTMLButtonElement).style.color = "var(--text-muted)";
            }}
            style={{
              width: 32, height: 32,
              borderRadius: 8,
              border: "none",
              background: "transparent",
              color: "var(--text-muted)",
              cursor: isConfigured && !isRunning ? "pointer" : "not-allowed",
              display: "flex", alignItems: "center", justifyContent: "center",
              flexShrink: 0,
              transition: "background 0.15s, color 0.15s",
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
            </svg>
          </button>

          {/* Screenshot / paste image button */}
          <button
            onClick={() => void handleScreenshot()}
            disabled={!isConfigured || isRunning}
            title="粘贴截图（需先 Cmd+Shift+4 截图至剪贴板）"
            onMouseEnter={e => {
              if (isConfigured && !isRunning) {
                (e.currentTarget as HTMLButtonElement).style.background = "var(--accent-dim)";
                (e.currentTarget as HTMLButtonElement).style.color = "var(--accent)";
              }
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLButtonElement).style.background = pendingImages.length > 0 ? "var(--accent-dim)" : "transparent";
              (e.currentTarget as HTMLButtonElement).style.color = pendingImages.length > 0 ? "var(--accent)" : "var(--text-muted)";
            }}
            style={{
              width: 32, height: 32,
              borderRadius: 8,
              border: pendingImages.length > 0 ? "1px solid rgba(79,110,247,0.35)" : "none",
              background: pendingImages.length > 0 ? "var(--accent-dim)" : "transparent",
              color: pendingImages.length > 0 ? "var(--accent)" : "var(--text-muted)",
              cursor: isConfigured && !isRunning ? "pointer" : "not-allowed",
              display: "flex", alignItems: "center", justifyContent: "center",
              flexShrink: 0,
              transition: "background 0.15s, color 0.15s",
              position: "relative",
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect width="18" height="18" x="3" y="3" rx="2" ry="2"/>
              <circle cx="9" cy="9" r="2"/>
              <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>
            </svg>
            {pendingImages.length > 0 && (
              <span style={{
                position: "absolute", top: 1, right: 1,
                width: 14, height: 14, borderRadius: "50%",
                background: "var(--accent)", color: "#fff",
                fontSize: 9, fontWeight: 700,
                display: "flex", alignItems: "center", justifyContent: "center",
                lineHeight: 1,
              }}>{pendingImages.length}</span>
            )}
          </button>

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

          {/* Text input */}
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => {
              const val = e.target.value;
              setInput(val);
              const atMatch = val.match(/@([\w\u4e00-\u9fff]*)$/);
              if (atMatch) {
                // Always refresh agent list when @ is detected
                if (window.agentApi) {
                  void window.agentApi.listAgentDefs().then((list) =>
                    setAgents(list as Array<{id: string; name: string; description: string; isActive?: boolean}>)
                  );
                }
                setPickerRect(pickerAnchorRef.current?.getBoundingClientRect() ?? null);
                setAtQuery(atMatch[1]); setSlashQuery(null); return;
              }
              const slashMatch = val.match(/\/([-\w\u4e00-\u9fff]*)$/);
              if (slashMatch) {
                // Refresh skill list on every slash
                if (window.agentApi) {
                  void window.agentApi.listSkills().then((list) =>
                    setSkills((list as Array<{name: string; description: string}>).filter(s => s.name))
                  ).catch((e: unknown) => console.error('[listSkills] slash error:', e));
                }
                setPickerRect(pickerAnchorRef.current?.getBoundingClientRect() ?? null);
                setSlashQuery(slashMatch[1]); setAtQuery(null); return;
              }
              setAtQuery(null);
              setSlashQuery(null);
            }}
            onBlur={() => setTimeout(() => { setAtQuery(null); setSlashQuery(null); }, 120)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && (atQuery !== null || slashQuery !== null)) {
                e.preventDefault();
                setAtQuery(null);
                setSlashQuery(null);
              } else if (e.key === "Escape" && isRunning) {
                e.preventDefault();
                handleAbort();
              } else if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder={isConfigured ? (isRunning ? "排队发送消息…" : "发送消息… (@智能体  /技能)") : "请先在设置中配置 API Key"}
            disabled={!isConfigured}
            style={{
              flex: 1,
              padding: "7px 4px",
              border: "none",
              background: "transparent",
              color: "var(--text-primary)",
              fontSize: 14,
              outline: 0,
              boxShadow: "none",
              fontFamily: "var(--font-body)",
              letterSpacing: "0.01em",
            }}
          />

          {/* Send / Queue / Stop button */}
          {isRunning ? (
            <>
              {/* Queue send button */}
              <button
                onClick={handleSend}
                disabled={!isConfigured || !input.trim()}
                title="排队发送（等当前对话结束后自动执行）"
                style={{
                  height: 34,
                  padding: "0 14px",
                  borderRadius: 10,
                  border: "none",
                  background: isConfigured && input.trim()
                    ? "var(--accent)"
                    : "var(--bg-deep)",
                  color: isConfigured && input.trim()
                    ? "var(--text-inverse)"
                    : "var(--text-muted)",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: isConfigured && input.trim() ? "pointer" : "not-allowed",
                  transition: "all 0.2s var(--ease-out)",
                  display: "flex", alignItems: "center", gap: 5,
                  whiteSpace: "nowrap",
                  flexShrink: 0,
                  letterSpacing: "0.02em",
                }}
              >
                排队
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12h14M12 5l7 7-7 7"/>
                </svg>
              </button>
              {/* Stop button */}
              <button
                onClick={handleAbort}
                title="停止生成 (Esc)"
                style={{
                  height: 34,
                  width: 34,
                  borderRadius: 10,
                  border: "none",
                  background: "rgba(244,63,94,0.12)",
                  color: "var(--danger)",
                  cursor: "pointer",
                  transition: "all 0.2s var(--ease-out)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  flexShrink: 0,
                }}
                onMouseEnter={e => {
                  (e.currentTarget as HTMLButtonElement).style.background = "rgba(244,63,94,0.22)";
                }}
                onMouseLeave={e => {
                  (e.currentTarget as HTMLButtonElement).style.background = "rgba(244,63,94,0.12)";
                }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="4" y="4" width="16" height="16" rx="2"/>
                </svg>
              </button>
            </>
          ) : (
            <button
              onClick={handleSend}
              disabled={!isConfigured || !input.trim()}
              style={{
                height: 34,
                padding: "0 16px",
                borderRadius: 10,
                border: "none",
                background: isConfigured && input.trim()
                  ? "var(--accent)"
                  : "var(--bg-deep)",
                color: isConfigured && input.trim()
                  ? "var(--text-inverse)"
                  : "var(--text-muted)",
                fontSize: 13,
                fontWeight: 600,
                cursor: isConfigured && input.trim() ? "pointer" : "not-allowed",
                transition: "all 0.2s var(--ease-out)",
                boxShadow: isConfigured && input.trim()
                  ? "0 2px 10px var(--accent-glow)"
                  : "none",
                display: "flex", alignItems: "center", gap: 5,
                whiteSpace: "nowrap",
                flexShrink: 0,
                letterSpacing: "0.02em",
              }}
            >
              发送
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 19V5M5 12l7-7 7 7"/>
              </svg>
            </button>
          )}
          </div>{/* end inner input row */}
        </div>{/* end input box */}
        </div>{/* end relative wrapper */}

        {/* Hint */}
        <div style={{
          textAlign: "center",
          marginTop: 7,
          fontSize: 11,
          color: "var(--text-muted)",
          letterSpacing: "0.03em",
          opacity: 0.6,
        }}>
          Enter 发送{isRunning ? "（排队）" : ""} · @智能体（可多选）· /技能 · Shift+Enter 换行
        </div>
      </div>

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