import { create } from "zustand";
import type { ContextUsageSnapshot } from "@agent/core";
import type { CronTask } from "../global";

export type { ContextUsageSnapshot, CronTask };

export interface StreamEvent {
  type: string;
  /** Session ID attached by agent-host; used for routing in the renderer */
  _sid?: string;
  text?: string;
  message?: string;
  toolCall?: { id: string; name: string; arguments: Record<string, unknown> };
  result?: { toolCallId: string; content: string; isError?: boolean };
  finalText?: string;
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
  /** For ask_user events */
  questionId?: string;
  question?: string;
  options?: Array<{ label: string; description: string }>;
  multiSelect?: boolean;
  /** For show_widget events */
  widgetId?: string;
  widgetType?: string;
  widgetData?: Record<string, unknown>;
}

export function findLatestContextUsage(
  events: Array<{ type?: string; usage?: ContextUsageSnapshot }>,
): ContextUsageSnapshot | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "context_usage" && events[i].usage) return events[i].usage;
  }
  return undefined;
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
  }>;
  toolCallId?: string;
  name?: string;
  /** True when this message is a context-compaction banner, not a real chat bubble */
  isCompactionSummary?: boolean;
  /** Base64 data URLs of images attached to this user message */
  images?: string[];
  /** True when this user message is queued and waiting for the current run to finish */
  isQueued?: boolean;
  /** True when this user message has been steered into the running loop */
  isSteered?: boolean;
  /** ask_user question data */
  askUser?: {
    questionId: string;
    question: string;
    options?: Array<{ label: string; description: string }>;
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
  getContextUsageForSession: (sessionId: string) => ContextUsageSnapshot | undefined;
  /** Update a specific message by ID using a transform function */
  updateMessage: (id: string, updater: (msg: ChatMessage) => ChatMessage, sessionId?: string) => void;
  clearMessages: (sessionId?: string) => void;
  setTodos: (todos: TodoItem[]) => void;
  setCronTasks: (tasks: CronTask[]) => void;
}

function addMessageToList(messages: ChatMessage[], msg: ChatMessage): ChatMessage[] {
  if (msg.role === "assistant" && msg.toolCalls?.length) {
    const last = messages[messages.length - 1];
    if (last && last.role === "assistant" && !last.toolCalls?.length) {
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
  if (lastMsg && lastMsg.role === "assistant" && !lastMsg.toolCalls?.length && !lastMsg.askUser && !lastMsg.isCompactionSummary) {
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

export const useAgentStore = create<AgentState>((set, get) => ({
  messages: [],
  messagesBySession: {},
  contextUsageBySession: {},
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
      const visibleMessages = targetSid && targetSid !== state.sessionId
        ? state.messages
        : appendTextToList(state.messages, text);
      const messagesBySession = targetSid
        ? {
            ...state.messagesBySession,
            [targetSid]: appendTextToList(state.messagesBySession[targetSid] ?? (targetSid === state.sessionId ? state.messages : []), text),
          }
        : state.messagesBySession;
      return {
        messages: visibleMessages,
        messagesBySession,
        currentText: targetSid && targetSid !== state.sessionId ? state.currentText : state.currentText + text,
      };
    }),

  setRunningSession: (id) => set({ runningSessionId: id }),

  setSessionId: (id) => set({ sessionId: id }),

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
    return {
      messages,
      messagesBySession: targetSid ? { ...state.messagesBySession, [targetSid]: messages } : state.messagesBySession,
      currentText: "",
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
    return {
      messages: targetSid === state.sessionId ? [] : state.messages,
      messagesBySession,
      contextUsageBySession,
      currentText: targetSid === state.sessionId ? "" : state.currentText,
    };
  }),

  setTodos: (todos) => set({ todos }),

  setCronTasks: (tasks) => set({ cronTasks: tasks }),
}));
