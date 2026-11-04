import { useCallback, useReducer } from "react";

export interface ErrorNotice {
  source: string;
  title: string;
  message: string;
  onRetry?: () => void;
}

export interface ErrorNoticeState {
  notice: ErrorNotice | null;
  reported: Record<string, string>;
}

type Event = { type: "report"; notice: ErrorNotice; repeat: boolean }
  | { type: "recover"; source: string }
  | { type: "dismiss" };

export const initialErrorNoticeState: ErrorNoticeState = { notice: null, reported: {} };

/** Acknowledgement silences one continuous failure; recovery rearms that source. */
export function errorNoticeReducer(state: ErrorNoticeState, event: Event): ErrorNoticeState {
  if (event.type === "dismiss") return { ...state, notice: null };
  if (event.type === "recover") {
    if (!(event.source in state.reported)) return state;
    const reported = { ...state.reported };
    delete reported[event.source];
    return { reported, notice: state.notice?.source === event.source ? null : state.notice };
  }
  if (!event.repeat && state.reported[event.notice.source] === event.notice.message) return state;
  return { notice: event.notice, reported: { ...state.reported, [event.notice.source]: event.notice.message } };
}

export function useErrorNotice() {
  const [state, dispatch] = useReducer(errorNoticeReducer, initialErrorNoticeState);
  const report = useCallback((notice: ErrorNotice, repeat = false) => dispatch({ type: "report", notice, repeat }), []);
  const recover = useCallback((source: string) => dispatch({ type: "recover", source }), []);
  const dismiss = useCallback(() => dispatch({ type: "dismiss" }), []);
  return { notice: state.notice, report, recover, dismiss };
}
