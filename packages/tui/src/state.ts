import type { AgentEvent, TokenUsage } from "@agent/core";

export type TranscriptEntry =
  | { id: string; type: "user"; text: string }
  | { id: string; type: "assistant"; text: string }
  | { id: string; type: "notice"; text: string }
  | { id: string; type: "error"; text: string }
  | { id: string; type: "tool"; name: string; text: string; full?: string; error?: boolean };

/** Live view truncates tool payloads; scrollback keeps a bounded full copy. */
const TOOL_FULL_LIMIT = 8000;

export interface ProgressState {
  label: string;
  startedAt: number;
  completedAt?: number;
  usage?: TokenUsage;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  turns: number;
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
  usage: UsageTotals;
}

export type TuiAction =
  | { type: "set_input"; input: string; cursor: number }
  | { type: "submit_input"; input: string }
  | { type: "turn_start"; now: number }
  | { type: "agent_event"; event: AgentEvent; now: number }
  | { type: "append"; entry: TranscriptEntry }
  | { type: "replace_transcript"; entries: TranscriptEntry[] }
  | { type: "history"; direction: -1 | 1 }
  | { type: "clear" };

export const initialTuiState = (history: string[] = []): TuiState => ({
  transcript: [],
  input: "",
  cursor: 0,
  history: [...history],
  historyIndex: history.length,
  running: false,
  progress: null,
  streamEntryId: null,
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, turns: 0 },
});

function nextId(prefix: string, count: number): string {
  return `${prefix}:${Date.now()}:${count}`;
}

function flat(value: unknown, limit: number): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value ?? {});
  const flattened = raw.replace(/\s+/g, " ");
  return flattened.slice(0, limit) + (flattened.length > limit ? "..." : "");
}

function flattenFull(value: unknown): string {
  // String payloads (patch bodies, shell commands, tool output) read better
  // raw than as pretty-printed JSON.
  const direct = typeof value === "string"
    ? value
    : pickStringField(value, ["patch", "command", "content", "url", "query"]);
  const raw = direct ?? JSON.stringify(value ?? null, null, 2);
  return raw.slice(0, TOOL_FULL_LIMIT) + (raw.length > TOOL_FULL_LIMIT ? "\n…(已截断)" : "");
}

function pickStringField(value: unknown, fields: string[]): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  for (const field of fields) {
    const candidate = (value as Record<string, unknown>)[field];
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return null;
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
          full: flattenFull(event.toolCall.arguments),
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
          full: flattenFull(event.result.content),
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
    case "done": {
      const usage = event.usage
        ? {
            inputTokens: state.usage.inputTokens + event.usage.inputTokens,
            outputTokens: state.usage.outputTokens + event.usage.outputTokens,
            totalTokens: state.usage.totalTokens + event.usage.totalTokens,
            turns: state.usage.turns + 1,
          }
        : state.usage;
      return {
        ...state,
        running: false,
        streamEntryId: null,
        usage,
        progress: state.progress ? { ...state.progress, completedAt: now, usage: event.usage } : null,
      };
    }
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
    case "replace_transcript":
      return { ...state, transcript: action.entries, progress: null, streamEntryId: null };
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
