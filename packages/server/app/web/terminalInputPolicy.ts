const TOUCH_SCROLL_ESCAPE_SEQUENCES = new Set(["\x1b[A", "\x1b[B", "\x1b[5~", "\x1b[6~"]);

export function shouldSuppressTouchScrollInput(data: string, touchScrollActive: boolean): boolean {
  return touchScrollActive && TOUCH_SCROLL_ESCAPE_SEQUENCES.has(data);
}
