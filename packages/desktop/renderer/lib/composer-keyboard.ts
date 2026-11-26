interface ComposerKeyEvent {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  repeat?: boolean;
  defaultPrevented?: boolean;
  nativeEvent: { isComposing?: boolean; keyCode?: number };
}

/** IME candidate keys belong to the input method, including Safari's 229 fallback. */
export function composerKeyAction(
  event: ComposerKeyEvent,
  state: { pickerOpen: boolean; pickerOptions?: number; predictionVisible?: boolean; running: boolean },
): "dismiss-picker" | "accept-option" | "next-option" | "previous-option" | "dismiss-prediction" | "accept-prediction" | "abort" | "send" | null {
  if (event.defaultPrevented || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return null;
  if (event.key === "Escape") {
    if (event.repeat) return null;
    if (state.pickerOpen) return "dismiss-picker";
    if (state.predictionVisible) return "dismiss-prediction";
    return state.running ? "abort" : null;
  }
  if (!event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
    if (state.pickerOptions) {
      if (event.key === "Tab" || event.key === "Enter") return "accept-option";
      if (event.key === "ArrowDown") return "next-option";
      if (event.key === "ArrowUp") return "previous-option";
    }
    if (event.key === "Tab" && !event.repeat && state.predictionVisible) return "accept-prediction";
  }
  return event.key === "Enter" && !event.shiftKey ? "send" : null;
}
