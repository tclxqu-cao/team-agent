const TOUCH_SCROLL_ESCAPE_SEQUENCES = new Set(["\x1b[A", "\x1b[B", "\x1b[5~", "\x1b[6~"]);

export function shouldSuppressTouchScrollInput(data: string, touchScrollActive: boolean): boolean {
  return touchScrollActive && TOUCH_SCROLL_ESCAPE_SEQUENCES.has(data);
}

export function terminalClipboardShortcut(
  event: Pick<KeyboardEvent, "key" | "type" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">,
  hasSelection: boolean,
): "copy" | "paste" | null {
  if (event.type !== "keydown" || event.altKey) return null;
  const key = event.key.toLowerCase();
  if (key === "c" && (event.metaKey || (event.ctrlKey && (event.shiftKey || hasSelection)))) return "copy";
  if (key === "v" && (event.metaKey || event.ctrlKey)) return "paste";
  return null;
}
