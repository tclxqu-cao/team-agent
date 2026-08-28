import type { AgentEvent, TokenUsage } from "@agent/core";

export type TranscriptEntry =
  | { id: string; type: "user"; text: string }
  | { id: string; type: "assistant"; text: string }
  | { id: string; type: "notice"; text: string }
  | { id: string; type: "error"; text: string }
  | { id: string; type: "tool"; name: string; text: string; error?: boolean };

export interface ProgressState {
  label: string;
  startedAt: number;
  completedAt?: number;
  usage?: TokenUsage;
}

export interface TuiState {
  transcript: TranscriptEntry[];
  input: string;
  cursor: number;
  history: string[];
  historyIndex: number;
  running: boolean;
  progress: ProgressState | null;
  streamEntryId: string | null;
}

export type TuiAction =
  | { type: "set_input"; input: string; cursor: number }
  | { type: "submit_input"; input: string }
  | { type: "turn_start"; now: number }
  | { type: "agent_event"; event: AgentEvent; now: number }
  | { type: "append"; entry: TranscriptEntry }
  | { type: "history"; direction: -1 | 1 }
  | { type: "clear" };

export const initialTuiState: TuiState = {
  transcript: [],
  input: "",
  cursor: 0,
  history: [],
  historyIndex: 0,
  running: false,
  progress: null,
  streamEntryId: null,
};

function nextId(prefix: string, count: number): string {
  return `${prefix}:${Date.now()}:${count}`;
}

function flat(value: unknown, limit: number): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value ?? {});
  const flattened = raw.replace(/\s+/g, " ");
  return flattened.slice(0, limit) + (flattened.length > limit ? "..." : "");
}

function thinkingLabel(message: string): string {
  const iteration = /^Iteration (\d+)\.\.\.$/.exec(message);
  if (iteration) return `思考中 · 第 ${iteration[1]} 轮`;
  if (message.startsWith("Retrying")) return "重试中";
  if (message.toLowerCase().includes("compacting")) return "整理上下文";
  if (message.startsWith("Preparing")) return "准备上下文";
  return "思考中";
}

function reduceEvent(state: TuiState, event: AgentEvent, now: number): TuiState {
  switch (event.type) {
    case "thinking":
      return { ...state, progress: { ...(state.progress ?? { startedAt: now }), label: thinkingLabel(event.message) } };
    case "text_chunk": {
      const id = state.streamEntryId ?? nextId("assistant", state.transcript.length);
      const existing = state.transcript.find((entry) => entry.id === id);
      const transcript = existing
        ? state.transcript.map((entry) => entry.id === id && entry.type === "assistant" ? { ...entry, text: entry.text + event.text } : entry)
        : [...state.transcript, { id, type: "assistant" as const, text: event.text }];
      return { ...state, transcript, streamEntryId: id };
    }
    case "text_done":
      return { ...state, streamEntryId: null };
    case "tool_call":
      return {
        ...state,
        streamEntryId: null,
        progress: { ...(state.progress ?? { startedAt: now }), label: `执行工具 · ${event.toolCall.name}` },
        transcript: [...state.transcript, {
          id: nextId("tool", state.transcript.length),
          type: "tool",
          name: event.toolCall.name,
          text: flat(event.toolCall.arguments, 140),
        }],
      };
    case "tool_result":
      return {
        ...state,
        transcript: [...state.transcript, {
          id: nextId("result", state.transcript.length),
          type: "tool",
          name: event.result.isError ? "失败" : "结果",
          text: flat(event.result.content, 180),
          error: event.result.isError,
        }],
      };
    case "error":
      return {
        ...state,
        running: false,
        progress: null,
        streamEntryId: null,
        transcript: [...state.transcript, { id: nextId("error", state.transcript.length), type: "error", text: event.message }],
      };
    case "turn_aborted":
      return {
        ...state,
        running: false,
        progress: null,
        streamEntryId: null,
        transcript: [...state.transcript, { id: nextId("notice", state.transcript.length), type: "notice", text: "已中断当前回复" }],
      };
    case "done":
      return {
        ...state,
        running: false,
        streamEntryId: null,
        progress: state.progress ? { ...state.progress, completedAt: now, usage: event.usage } : null,
      };
    default:
      return state;
  }
}

export function tuiReducer(state: TuiState, action: TuiAction): TuiState {
  switch (action.type) {
    case "set_input":
      return { ...state, input: action.input, cursor: action.cursor, historyIndex: state.history.length };
    case "submit_input":
      return {
        ...state,
        input: "",
        cursor: 0,
        history: action.input ? [...state.history, action.input] : state.history,
        historyIndex: action.input ? state.history.length + 1 : state.history.length,
      };
    case "turn_start":
      return { ...state, running: true, progress: { label: "准备上下文", startedAt: action.now }, streamEntryId: null };
    case "agent_event":
      return reduceEvent(state, action.event, action.now);
    case "append":
      return { ...state, transcript: [...state.transcript, action.entry] };
    case "history": {
      if (state.history.length === 0) return state;
      const index = Math.max(0, Math.min(state.history.length, state.historyIndex + action.direction));
      const input = index === state.history.length ? "" : state.history[index];
      return { ...state, historyIndex: index, input, cursor: input.length };
    }
    case "clear":
      return { ...state, transcript: [], progress: null, streamEntryId: null };
  }
}

export function formatElapsed(elapsedMs: number): string {
  const seconds = Math.max(0, elapsedMs) / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}
