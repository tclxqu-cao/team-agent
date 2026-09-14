import { create } from "zustand";
import type {
  AgentEvent,
  type AskUserField,
  type ContextUsageSnapshot,
  type MessagePresentation,
  type NativeSubagentActivity,
  type RuntimeProgress,
  type SessionToolResultRef,
} from "@agent/core";
import type { CronTask } from "../global";
import {
  applyCodexLiveExecutionEvent,
  type CodexLiveExecutionEvent,
} from "../lib/codex-execution-trace";
import { mergeReasoningSummaryDelta, upsertRuntimeProgress } from "../lib/native-runtime-progress";

export type { ContextUsageSnapshot, CronTask };

export interface StreamEvent {
  type: string;
  /** Session ID attached by agent-host; used for routing in the renderer */
  _sid?: string;
  /** Durable broker event identity used to ignore snapshot/SSE replay duplicates. */
  _nativeRunId?: string;
  _nativeSequence?: number;
  /** An admission conflict occurred while an existing native turn remains live. */
  _preserveActiveRun?: boolean;
  text?: string;
  message?: string;
  code?: string;
  toolCall?: { id: string; name: string; arguments: Record<string, unknown> };
  result?: { toolCallId: string; content: string; isError?: boolean };
  finalText?: string;
  durationMs?: number;
  usage?: ContextUsageSnapshot;
  todos?: TodoItem[];
  tasks?: CronTask[];
  agentName?: string;
  task?: string;
  subSessionId?: string;
  /** For agent_done: "completed" | "failed" */
  status?: string;
  summary?: string;
  error?: string;
  removedMessages?: number;
  itemId?: string;
  messagePhase?: "commentary" | "final_answer";
  sectionIndex?: number;
  delta?: string;
  turnId?: string;
  progressId?: string;
  phase?: RuntimeProgress["phase"];
  label?: string;
  detail?: string;
  toolCallId?: string;
  elapsedSeconds?: number;
  current?: number;
  total?: number;
  /** For ask_user events */
  questionId?: string;
  question?: string;
  options?: Array<{ label: string; description: string }>;
  fields?: AskUserField[];
  multiSelect?: boolean;
  /** For show_widget events */
  widgetId?: string;
  widgetType?: string;
  widgetData?: Record<string, unknown>;
  activity?: NativeSubagentActivity;
}

export function findLatestContextUsage(
  events: Array<{ type?: string; usage?: ContextUsageSnapshot }>,
): ContextUsageSnapshot | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "context_usage" && events[i].usage) return events[i].usage;
  }
  return undefined;
}

export function reduceNativeSubagentActivities(
  events: Array<{ type?: string; activity?: NativeSubagentActivity }>,
): NativeSubagentActivity[] {
  const activities = new Map<string, NativeSubagentActivity>();
  for (const event of events) {
    if (event.type === "native_subagent_update" && event.activity?.parentToolCallId) {
      activities.set(event.activity.parentToolCallId, event.activity);
    }
  }
  return [...activities.values()];
}

export interface TodoItem {
  id: string;
  title: string;
  agentName?: string;
  status: "pending" | "in-progress" | "completed";
  dependsOn?: string[];
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  /** Name of the agent that was @-mentioned for this message */
  agentName?: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
    result?: string;
    isError?: boolean;
    resultRef?: SessionToolResultRef;
  }>;
  toolCallId?: string;
  toolResultRef?: SessionToolResultRef;
  name?: string;
  /** True when this message is a context-compaction banner, not a real chat bubble */
  isCompactionSummary?: boolean;
  /** Base64 data URLs of images attached to this user message */
  images?: string[];
  /** Display-only metadata restored from an external runtime. */
  presentation?: MessagePresentation;
  /** Collapsed Codex execution details loaded only when this row is expanded. */
  executionTrace?: {
    turnId: string;
    revision: string;
    liveMessages?: ChatMessage[];
  };
  /** True when this user message is queued and waiting for the current run to finish */
  isQueued?: boolean;
  /** Durable broker queue identity; absent for legacy in-memory queues. */
  queueItemId?: string;
  /** True when this user message has been steered into the running loop */
  isSteered?: boolean;
  /** Identifies a goal-mode user message and links it to the durable goal queue. */
  isGoal?: boolean;
  goalId?: string;
  /** ask_user question data */
  askUser?: {
    questionId: string;
    question: string;
    options?: Array<{ label: string; description: string }>;
    fields?: AskUserField[];
    multiSelect?: boolean;
    answered?: boolean;
    answer?: string;
  };
  /** Widget card data (from show_widget events) */
  widget?: { widgetId: string; widgetType: string; data: Record<string, unknown> };
  timestamp: number;
}

interface AgentState {
  messages: ChatMessage[];
  messagesBySession: Record<string, ChatMessage[]>;
  contextUsageBySession: Record<string, ContextUsageSnapshot>;
  runtimeProgressBySession: Record<string, RuntimeProgress[]>;
  nativeSubagentsBySession: Record<string, Record<string, NativeSubagentActivity>>;
  /** The sessionId currently being streamed; null when idle */
  runningSessionId: string | null;
  currentText: string;
  sessionId: string | null;
  /** Shared todo list updated by agent tools during runs */
  todos: TodoItem[];
  /** All scheduled cron tasks (app-wide) */
  cronTasks: CronTask[];

  addMessage: (msg: ChatMessage, sessionId?: string) => void;
  appendText: (text: string, sessionId?: string) => void;
  setRunningSession: (id: string | null) => void;
  setSessionId: (id: string) => void;
  updateToolResult: (toolCallId: string, result: string, isError?: boolean, sessionId?: string) => void;
  /** Mark a dispatch_agent toolCall as completed or failed by subSessionId */
  updateSubAgentStatus: (subSessionId: string, status: "completed" | "failed", detail?: string, sessionId?: string) => void;
  /** Append streaming text to a running dispatch_agent toolCall's live progress */
  updateSubAgentProgress: (subSessionId: string, text: string, sessionId?: string) => void;
  setMessages: (messages: ChatMessage[], sessionId?: string) => void;
  getMessagesForSession: (sessionId: string) => ChatMessage[];
  setContextUsage: (usage: ContextUsageSnapshot, sessionId?: string) => void;
  applyRuntimeProgress: (progress: RuntimeProgress, sessionId?: string) => void;
  setRuntimeProgress: (progress: RuntimeProgress[], sessionId?: string) => void;
  clearRuntimeProgress: (sessionId?: string) => void;
  applyNativeSubagentActivity: (activity: NativeSubagentActivity, sessionId?: string) => void;
  setNativeSubagentActivities: (activities: NativeSubagentActivity[], sessionId?: string) => void;
  applyReasoningSummary: (
    event: Extract<AgentEvent, { type: "reasoning_summary_delta" }>,
    sessionId?: string,
  ) => void;
  applyCodexExecutionEvent: (
    turnId: string,
    event: CodexLiveExecutionEvent,
    sessionId?: string,
  ) => void;
  getContextUsageForSession: (sessionId: string) => ContextUsageSnapshot | undefined;
  /** Update a specific message by ID using a transform function */
  updateMessage: (id: string, updater: (msg: ChatMessage) => ChatMessage, sessionId?: string) => void;
  clearMessages: (sessionId?: string) => void;
  setTodos: (todos: TodoItem[]) => void;
  setCronTasks: (tasks: CronTask[]) => void;
}

function canAppendAssistantOutput(message: ChatMessage | undefined): message is ChatMessage {
  return Boolean(message
    && message.role === "assistant"
    && !message.toolCalls?.length
    && !message.widget
    && !message.askUser
    && !message.isCompactionSummary
    && !message.executionTrace);
}

function addMessageToList(messages: ChatMessage[], msg: ChatMessage): ChatMessage[] {
  if (msg.role === "assistant" && msg.toolCalls?.length) {
    const last = messages[messages.length - 1];
    if (canAppendAssistantOutput(last)) {
      return [
        ...messages.slice(0, -1),
        { ...last, content: last.content, toolCalls: msg.toolCalls },
      ];
    }
  }
  return [...messages, msg];
}

function appendTextToList(messages: ChatMessage[], text: string): ChatMessage[] {
  if (!text) return messages;
  const lastMsg = messages[messages.length - 1];
  if (canAppendAssistantOutput(lastMsg)) {
    const updated = [...messages];
    updated[updated.length - 1] = { ...lastMsg, content: lastMsg.content + text };
    return updated;
  }
  return [
    ...messages,
    {
      id: crypto.randomUUID(),
      role: "assistant",
      content: text,
      timestamp: Date.now(),
    },
  ];
}

function updateToolResultInList(messages: ChatMessage[], toolCallId: string, result: string, isError?: boolean): ChatMessage[] {
  return messages.map((m) => {
    if (!m.toolCalls) return m;
    const updatedCalls = m.toolCalls.map((tc) =>
      tc.id === toolCallId ? { ...tc, result, isError } : tc,
    );
    return { ...m, toolCalls: updatedCalls };
  });
}

function updateSubAgentStatusInList(messages: ChatMessage[], subSessionId: string, status: "completed" | "failed", detail?: string): ChatMessage[] {
  return messages.map((m) => {
    if (!m.toolCalls) return m;
    const updatedCalls = m.toolCalls.map((tc) =>
      tc.name === "dispatch_agent" && tc.arguments.subSessionId === subSessionId
        ? { ...tc, arguments: { ...tc.arguments, subAgentStatus: status, subAgentDetail: detail } }
        : tc
    );
    return { ...m, toolCalls: updatedCalls };
  });
}

function updateSubAgentProgressInList(messages: ChatMessage[], subSessionId: string, text: string): ChatMessage[] {
  return messages.map((m) => {
    if (!m.toolCalls) return m;
    const updatedCalls = m.toolCalls.map((tc) =>
      tc.name === "dispatch_agent" && tc.arguments.subSessionId === subSessionId
        ? { ...tc, arguments: { ...tc.arguments, subAgentProgress: ((tc.arguments.subAgentProgress as string | undefined) ? ((tc.arguments.subAgentProgress as string) + "\n" + text) : text).split("\n").slice(-30).join("\n") } }
        : tc
    );
    return { ...m, toolCalls: updatedCalls };
  });
}

function updateMessageInList(messages: ChatMessage[], id: string, updater: (msg: ChatMessage) => ChatMessage): ChatMessage[] {
  return messages.map((m) => (m.id === id ? updater(m) : m));
}

function applyReasoningSummaryToList(
  messages: ChatMessage[],
  event: Extract<AgentEvent, { type: "reasoning_summary_delta" }>,
): ChatMessage[] {
  const index = messages.findIndex((message) => message.presentation?.reasoning?.some(
    (section) => section.itemId === event.itemId,
  ));
  if (index < 0) {
    return [...messages, {
      id: `native-reasoning:${event.itemId}`,
      role: "assistant",
      content: "",
      presentation: { reasoning: mergeReasoningSummaryDelta(undefined, event) },
      timestamp: Date.now(),
    }];
  }
  return messages.map((message, messageIndex) => messageIndex === index
    ? {
        ...message,
        presentation: {
          ...message.presentation,
          reasoning: mergeReasoningSummaryDelta(message.presentation?.reasoning, event),
        },
      }
    : message);
}

export const useAgentStore = create<AgentState>((set, get) => ({
  messages: [],
  messagesBySession: {},
  contextUsageBySession: {},
  runtimeProgressBySession: {},
  nativeSubagentsBySession: {},
  runningSessionId: null,
  currentText: "",
  sessionId: null,
  todos: [],
  cronTasks: [],

  addMessage: (msg, sid) =>
    set((state) => {
      const targetSid = sid ?? state.sessionId ?? undefined;
      const visibleMessages = targetSid && targetSid !== state.sessionId
        ? state.messages
        : addMessageToList(state.messages, msg);
      const messagesBySession = targetSid
        ? {
            ...state.messagesBySession,
            [targetSid]: addMessageToList(state.messagesBySession[targetSid] ?? (targetSid === state.sessionId ? state.messages : []), msg),
          }
        : state.messagesBySession;
      return {
        messages: visibleMessages,
        messagesBySession,
        currentText: targetSid && targetSid !== state.sessionId ? state.currentText : "",
      };
    }),

  appendText: (text, sid) =>
    set((state) => {
      if (!text) return state;
      const targetSid = sid ?? state.sessionId ?? undefined;
      const isVisibleSession = !targetSid || targetSid === state.sessionId;
      const updatedMessages = appendTextToList(
        isVisibleSession ? state.messages : state.messagesBySession[targetSid!] ?? [],
        text,
      );
      const messagesBySession = targetSid
        ? {
            ...state.messagesBySession,
            [targetSid]: updatedMessages,
          }
        : state.messagesBySession;
      return {
        messages: isVisibleSession ? updatedMessages : state.messages,
        messagesBySession,
        currentText: targetSid && targetSid !== state.sessionId ? state.currentText : state.currentText + text,
      };
    }),

  setRunningSession: (id) => set({ runningSessionId: id }),

  setSessionId: (id) => set((state) => {
    if (state.sessionId === id) return state;
    // Events may arrive before ChatView restores history. Never leave the
    // previous session's messages attached to the newly selected ID.
    return {
      sessionId: id,
      messages: state.messagesBySession[id] ?? [],
      currentText: "",
    };
  }),

  updateToolResult: (toolCallId, result, isError, sid) =>
    set((state) => {
      const targetSid = sid ?? state.sessionId ?? undefined;
      const visibleMessages = targetSid && targetSid !== state.sessionId
        ? state.messages
        : updateToolResultInList(state.messages, toolCallId, result, isError);
      const messagesBySession = targetSid
        ? {
            ...state.messagesBySession,
            [targetSid]: updateToolResultInList(state.messagesBySession[targetSid] ?? (targetSid === state.sessionId ? state.messages : []), toolCallId, result, isError),
          }
        : state.messagesBySession;
      return { messages: visibleMessages, messagesBySession };
    }),

  setMessages: (messages, sid) => set((state) => {
    const targetSid = sid ?? state.sessionId ?? undefined;
    const isVisibleSession = !targetSid || targetSid === state.sessionId;
    return {
      messages: isVisibleSession ? messages : state.messages,
      messagesBySession: targetSid ? { ...state.messagesBySession, [targetSid]: messages } : state.messagesBySession,
      currentText: isVisibleSession ? "" : state.currentText,
    };
  }),

  getMessagesForSession: (sid) => get().messagesBySession[sid] ?? [],

  setContextUsage: (usage, sid) => set((state) => {
    const targetSid = sid ?? state.sessionId ?? undefined;
    if (!targetSid) return state;
    return {
      contextUsageBySession: {
        ...state.contextUsageBySession,
        [targetSid]: usage,
      },
    };
  }),

  getContextUsageForSession: (sid) => get().contextUsageBySession[sid],

  applyRuntimeProgress: (progress, sid) => set((state) => {
    const targetSid = sid ?? state.sessionId ?? undefined;
    if (!targetSid) return state;
    return {
      runtimeProgressBySession: {
        ...state.runtimeProgressBySession,
        [targetSid]: upsertRuntimeProgress(state.runtimeProgressBySession[targetSid] ?? [], progress),
      },
    };
  }),

  setRuntimeProgress: (progress, sid) => set((state) => {
    const targetSid = sid ?? state.sessionId ?? undefined;
    if (!targetSid) return state;
    return {
      runtimeProgressBySession: { ...state.runtimeProgressBySession, [targetSid]: progress },
    };
  }),

  clearRuntimeProgress: (sid) => set((state) => {
    const targetSid = sid ?? state.sessionId ?? undefined;
    if (!targetSid || !state.runtimeProgressBySession[targetSid]?.length) return state;
    const { [targetSid]: _removed, ...runtimeProgressBySession } = state.runtimeProgressBySession;
    return { runtimeProgressBySession };
  }),

  applyNativeSubagentActivity: (activity, sid) => set((state) => {
    const targetSid = sid ?? state.sessionId ?? undefined;
    if (!targetSid) return state;
    return {
      nativeSubagentsBySession: {
        ...state.nativeSubagentsBySession,
        [targetSid]: {
          ...(state.nativeSubagentsBySession[targetSid] ?? {}),
          [activity.parentToolCallId]: activity,
        },
      },
    };
  }),

  setNativeSubagentActivities: (activities, sid) => set((state) => {
    const targetSid = sid ?? state.sessionId ?? undefined;
    if (!targetSid) return state;
    return {
      nativeSubagentsBySession: {
        ...state.nativeSubagentsBySession,
        [targetSid]: Object.fromEntries(activities.map((activity) => [activity.parentToolCallId, activity])),
      },
    };
  }),

  applyReasoningSummary: (event, sid) => set((state) => {
    const targetSid = sid ?? state.sessionId ?? undefined;
    const visibleMessages = targetSid && targetSid !== state.sessionId
      ? state.messages
      : applyReasoningSummaryToList(state.messages, event);
    const messagesBySession = targetSid
      ? {
          ...state.messagesBySession,
          [targetSid]: applyReasoningSummaryToList(
            state.messagesBySession[targetSid] ?? (targetSid === state.sessionId ? state.messages : []),
            event,
          ),
        }
      : state.messagesBySession;
    return { messages: visibleMessages, messagesBySession };
  }),

  applyCodexExecutionEvent: (turnId, event, sid) => set((state) => {
    const targetSid = sid ?? state.sessionId ?? undefined;
    const timestamp = Date.now();
    const visibleMessages = targetSid && targetSid !== state.sessionId
      ? state.messages
      : applyCodexLiveExecutionEvent(state.messages, turnId, event, timestamp);
    const messagesBySession = targetSid
      ? {
          ...state.messagesBySession,
          [targetSid]: applyCodexLiveExecutionEvent(
            state.messagesBySession[targetSid] ?? (targetSid === state.sessionId ? state.messages : []),
            turnId,
            event,
            timestamp,
          ),
        }
      : state.messagesBySession;
    return { messages: visibleMessages, messagesBySession };
  }),

  updateMessage: (id, updater, sid) =>
    set((state) => {
      const targetSid = sid ?? state.sessionId ?? undefined;
      const visibleMessages = targetSid && targetSid !== state.sessionId
        ? state.messages
        : updateMessageInList(state.messages, id, updater);
      const messagesBySession = targetSid
        ? {
            ...state.messagesBySession,
            [targetSid]: updateMessageInList(state.messagesBySession[targetSid] ?? (targetSid === state.sessionId ? state.messages : []), id, updater),
          }
        : state.messagesBySession;
      return { messages: visibleMessages, messagesBySession };
    }),

  updateSubAgentStatus: (subSessionId, status, detail, sid) =>
    set((state) => {
      const targetSid = sid ?? state.sessionId ?? undefined;
      const visibleMessages = targetSid && targetSid !== state.sessionId
        ? state.messages
        : updateSubAgentStatusInList(state.messages, subSessionId, status, detail);
      const messagesBySession = targetSid
        ? {
            ...state.messagesBySession,
            [targetSid]: updateSubAgentStatusInList(state.messagesBySession[targetSid] ?? (targetSid === state.sessionId ? state.messages : []), subSessionId, status, detail),
          }
        : state.messagesBySession;
      return { messages: visibleMessages, messagesBySession };
    }),

  updateSubAgentProgress: (subSessionId, text, sid) =>
    set((state) => {
      const targetSid = sid ?? state.sessionId ?? undefined;
      const visibleMessages = targetSid && targetSid !== state.sessionId
        ? state.messages
        : updateSubAgentProgressInList(state.messages, subSessionId, text);
      const messagesBySession = targetSid
        ? {
            ...state.messagesBySession,
            [targetSid]: updateSubAgentProgressInList(state.messagesBySession[targetSid] ?? (targetSid === state.sessionId ? state.messages : []), subSessionId, text),
          }
        : state.messagesBySession;
      return { messages: visibleMessages, messagesBySession };
    }),

  clearMessages: (sid) => set((state) => {
    const targetSid = sid ?? state.sessionId ?? undefined;
    if (!targetSid) return { messages: [], currentText: "" };
    const { [targetSid]: _removedMessages, ...messagesBySession } = state.messagesBySession;
    const { [targetSid]: _removedUsage, ...contextUsageBySession } = state.contextUsageBySession;
    const { [targetSid]: _removedProgress, ...runtimeProgressBySession } = state.runtimeProgressBySession;
    const { [targetSid]: _removedSubagents, ...nativeSubagentsBySession } = state.nativeSubagentsBySession;
    return {
      messages: targetSid === state.sessionId ? [] : state.messages,
      messagesBySession,
      contextUsageBySession,
      runtimeProgressBySession,
      nativeSubagentsBySession,
      currentText: targetSid === state.sessionId ? "" : state.currentText,
    };
  }),

  setTodos: (todos) => set({ todos }),

  setCronTasks: (tasks) => set({ cronTasks: tasks }),
}));
