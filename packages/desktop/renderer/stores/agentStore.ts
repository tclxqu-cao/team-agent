import { create } from "zustand";
import type { CronTask } from "../global";

export type { CronTask };

export interface StreamEvent {
  type: string;
  /** Session ID attached by agent-host; used for routing in the renderer */
  _sid?: string;
  text?: string;
  message?: string;
  toolCall?: { id: string; name: string; arguments: Record<string, unknown> };
  result?: { toolCallId: string; content: string; isError?: boolean };
  finalText?: string;
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
  timestamp: number;
}

interface AgentState {
  messages: ChatMessage[];
  /** The sessionId currently being streamed; null when idle */
  runningSessionId: string | null;
  currentText: string;
  sessionId: string | null;
  /** Shared todo list updated by agent tools during runs */
  todos: TodoItem[];
  /** All scheduled cron tasks (app-wide) */
  cronTasks: CronTask[];

  addMessage: (msg: ChatMessage) => void;
  appendText: (text: string) => void;
  setRunningSession: (id: string | null) => void;
  setSessionId: (id: string) => void;
  updateToolResult: (toolCallId: string, result: string, isError?: boolean) => void;
  /** Mark a dispatch_agent toolCall as completed or failed by subSessionId */
  updateSubAgentStatus: (subSessionId: string, status: "completed" | "failed", detail?: string) => void;
  /** Append streaming text to a running dispatch_agent toolCall's live progress */
  updateSubAgentProgress: (subSessionId: string, text: string) => void;
  setMessages: (messages: ChatMessage[]) => void;
  clearMessages: () => void;
  setTodos: (todos: TodoItem[]) => void;
  setCronTasks: (tasks: CronTask[]) => void;
}

export const useAgentStore = create<AgentState>((set) => ({
  messages: [],
  runningSessionId: null,
  currentText: "",
  sessionId: null,
  todos: [],
  cronTasks: [],

  addMessage: (msg) =>
    set((state) => {
      // If adding a tool_call assistant message, merge into last assistant msg if it's empty/text-only
      if (msg.role === "assistant" && msg.toolCalls?.length) {
        const last = state.messages[state.messages.length - 1];
        if (last && last.role === "assistant" && !last.toolCalls?.length) {
          const merged = {
            ...last,
            content: last.content,
            toolCalls: msg.toolCalls,
          };
          return {
            messages: [...state.messages.slice(0, -1), merged],
            currentText: "",
          };
        }
      }
      return {
        messages: [...state.messages, msg],
        currentText: "",
      };
    }),

  appendText: (text) =>
    set((state) => {
      if (!text) return state; // ignore empty chunks
      const lastMsg = state.messages[state.messages.length - 1];
      if (lastMsg && lastMsg.role === "assistant" && !lastMsg.toolCalls?.length) {
        const updated = [...state.messages];
        updated[updated.length - 1] = { ...lastMsg, content: lastMsg.content + text };
        return { messages: updated, currentText: state.currentText + text };
      }
      return {
        messages: [
          ...state.messages,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: text,
            timestamp: Date.now(),
          },
        ],
        currentText: state.currentText + text,
      };
    }),

  setRunningSession: (id) => set({ runningSessionId: id }),

  setSessionId: (id) => set({ sessionId: id }),

  updateToolResult: (toolCallId, result, isError) =>
    set((state) => {
      const updated = state.messages.map((m) => {
        if (m.toolCalls) {
          const updatedCalls = m.toolCalls.map((tc) =>
            tc.id === toolCallId ? { ...tc, result, isError } : tc,
          );
          return { ...m, toolCalls: updatedCalls };
        }
        return m;
      });
      return { messages: updated };
    }),

  setMessages: (messages) => set({ messages, currentText: "" }),

  updateSubAgentStatus: (subSessionId, status, detail) =>
    set((state) => ({
      messages: state.messages.map((m) => {
        if (!m.toolCalls) return m;
        const updatedCalls = m.toolCalls.map((tc) =>
          tc.name === "dispatch_agent" && tc.arguments.subSessionId === subSessionId
            ? { ...tc, arguments: { ...tc.arguments, subAgentStatus: status, subAgentDetail: detail } }
            : tc
        );
        return { ...m, toolCalls: updatedCalls };
      }),
    })),

  updateSubAgentProgress: (subSessionId, text) =>
    set((state) => ({
      messages: state.messages.map((m) => {
        if (!m.toolCalls) return m;
        const updatedCalls = m.toolCalls.map((tc) =>
          tc.name === "dispatch_agent" && tc.arguments.subSessionId === subSessionId
            ? { ...tc, arguments: { ...tc.arguments, subAgentProgress: ((tc.arguments.subAgentProgress as string | undefined) ?? "") + text } }
            : tc
        );
        return { ...m, toolCalls: updatedCalls };
      }),
    })),

  clearMessages: () => set({ messages: [], currentText: "" }),

  setTodos: (todos) => set({ todos }),

  setCronTasks: (tasks) => set({ cronTasks: tasks }),
}));
