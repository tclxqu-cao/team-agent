interface ComposerKeyEvent {
  key: string;
  shiftKey?: boolean;
  repeat?: boolean;
  defaultPrevented?: boolean;
  nativeEvent: { isComposing?: boolean; keyCode?: number };
}

/** IME candidate keys belong to the input method, including Safari's 229 fallback. */
export function composerKeyAction(
  event: ComposerKeyEvent,
  state: { pickerOpen: boolean; running: boolean },
): "dismiss-picker" | "abort" | "send" | null {
  if (event.defaultPrevented || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return null;
  if (event.key === "Escape") {
    if (event.repeat) return null;
    return state.pickerOpen ? "dismiss-picker" : state.running ? "abort" : null;
  }
  return event.key === "Enter" && !event.shiftKey ? "send" : null;
}
