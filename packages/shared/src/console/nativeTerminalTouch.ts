import type { Terminal } from "@xterm/xterm";

export interface NativeTerminalTouch {
  hasSelection: () => boolean;
  ownsTouch: (target: EventTarget | null) => boolean;
  isHoldingText: () => boolean;
  consumeClick: () => boolean;
  dispose: () => void;
}

export function joinNativeTerminalSelection(
  rows: Array<{ text: string; wrapped: boolean }>,
  start: { row: number; offset: number },
  end: { row: number; offset: number },
): string {
  return rows.slice(start.row, end.row + 1).map((row, index) => {
    const rowIndex = start.row + index;
    const text = row.text.slice(rowIndex === start.row ? start.offset : 0, rowIndex === end.row ? end.offset : undefined);
    return `${index > 0 && !row.wrapped ? "\n" : ""}${text}`;
  }).join("");
}

export function handleNativeTerminalPaste(event: ClipboardEvent | InputEvent, textarea: HTMLTextAreaElement, paste: (text: string) => void): boolean {
  let text: string | null = null;
  if (event.type === "paste") {
    const clipboard = (event as ClipboardEvent).clipboardData;
    if (clipboard) text = clipboard.getData("text/plain");
  } else if ((event as InputEvent).inputType === "insertFromPaste") {
    text = (event as InputEvent).data;
    if (text === null && event.type === "input") text = textarea.value;
  }
  if (text === null) return false;
  event.preventDefault();
  event.stopImmediatePropagation();
  textarea.value = "";
  if (text) paste(text);
  return true;
}

export function installNativeTerminalTouch(terminal: Terminal, paste: (text: string) => void): NativeTerminalTouch | null {
  const root = terminal.element;
  const textarea = terminal.textarea;
  const screen = root?.querySelector<HTMLElement>(".xterm-screen");
  const originalRows = screen?.querySelector<HTMLElement>(".xterm-rows");
  if (!root || !textarea || !screen || !originalRows) return null;
  const ownerDocument = root.ownerDocument;
  const view = ownerDocument.defaultView;
  if (!view?.matchMedia("(hover: none) and (pointer: coarse)").matches) return null;

  const mirror = originalRows.cloneNode(false) as HTMLElement;
  mirror.classList.add("terminal-native-rows");
  mirror.setAttribute("aria-hidden", "true");
  screen.appendChild(mirror);
  root.classList.add("terminal-native-touch");
  let snapshotRows: Array<{ text: string; wrapped: boolean }> = [];
  let touch: { id: number; x: number; y: number; started: number; moved: boolean; input: boolean } | null = null;
  let ignoreClick = false;
  let holdUntil = 0;
  let resumeTimer: number | undefined;
  let renderFrame: number | undefined;
  let disposed = false;

  const nativeRange = () => {
    const selection = ownerDocument.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    return mirror.contains(range.startContainer) && mirror.contains(range.endContainer) ? range : null;
  };
  const hasSelection = () => nativeRange() !== null;
  const isHoldingText = () => hasSelection() || Boolean(touch && !touch.moved) || Date.now() < holdUntil;
  const ownsTouch = (target: EventTarget | null) => target === textarea || hasSelection()
    || Boolean(touch && !touch.moved && Date.now() - touch.started >= 450);

  const sync = () => {
    if (disposed || isHoldingText()) return;
    const buffer = terminal.buffer.active;
    const rows = Array.from(originalRows.children);
    mirror.style.backgroundColor = terminal.options.theme?.background ?? "#000000";
    snapshotRows = rows.map((row, index) => {
      const current = mirror.children[index];
      if (!current?.isEqualNode(row)) {
        const clone = row.cloneNode(true);
        if (current) mirror.replaceChild(clone, current);
        else mirror.appendChild(clone);
      }
      return { text: row.textContent ?? "", wrapped: buffer.getLine(buffer.viewportY + index)?.isWrapped ?? false };
    });
    while (mirror.children.length > rows.length) mirror.lastElementChild?.remove();
    const width = screen.getBoundingClientRect().width;
    const cellHeight = screen.getBoundingClientRect().height / Math.max(terminal.rows, 1);
    const cursorRow = buffer.baseY + buffer.cursorY - buffer.viewportY;
    const inputWidth = Math.min(80, width);
    const left = Math.min(buffer.cursorX * width / Math.max(terminal.cols, 1), width - inputWidth);
    textarea.style.setProperty("--native-input-left", `${Math.max(0, left)}px`);
    textarea.style.setProperty("--native-input-top", `${cursorRow * cellHeight}px`);
    textarea.style.setProperty("--native-input-width", `${inputWidth}px`);
    textarea.style.setProperty("--native-input-height", `${Math.max(32, cellHeight)}px`);
    textarea.style.setProperty("--native-input-events", cursorRow >= 0 && cursorRow < terminal.rows ? "auto" : "none");
  };
  const scheduleSync = () => {
    if (renderFrame !== undefined || disposed) return;
    renderFrame = view.requestAnimationFrame(() => { renderFrame = undefined; sync(); });
  };
  const selectionChanged = () => {
    if (hasSelection()) {
      terminal.clearSelection();
      ignoreClick = true;
    } else scheduleSync();
  };
  const pointerDown = (event: PointerEvent) => {
    if (event.pointerType !== "touch" || !event.isPrimary) return;
    view.clearTimeout(resumeTimer);
    holdUntil = 0;
    sync();
    ignoreClick = hasSelection() || event.target === textarea;
    touch = { id: event.pointerId, x: event.clientX, y: event.clientY, started: Date.now(), moved: false, input: event.target === textarea };
  };
  const pointerMove = (event: PointerEvent) => {
    if (!touch || touch.id !== event.pointerId || touch.input || ownsTouch(event.target)) return;
    if (Math.hypot(event.clientX - touch.x, event.clientY - touch.y) > 8) {
      touch.moved = true;
      ignoreClick = true;
      scheduleSync();
    }
  };
  const pointerEnd = (event: PointerEvent) => {
    if (!touch || touch.id !== event.pointerId) return;
    ignoreClick ||= touch.moved || touch.input || Date.now() - touch.started >= 450;
    if (!touch.moved) holdUntil = Date.now() + 350;
    touch = null;
    resumeTimer = view.setTimeout(scheduleSync, 350);
  };
  const mouseDown = (event: MouseEvent) => {
    if (terminal.modes.mouseTrackingMode !== "none" && !touch && !ignoreClick && !hasSelection()) return;
    event.stopPropagation();
  };
  const contextMenu = (event: MouseEvent) => {
    ignoreClick = true;
    event.stopPropagation();
  };
  const pasteEvent = (event: Event) => handleNativeTerminalPaste(event as ClipboardEvent | InputEvent, textarea, paste);
  const copyEvent = (event: ClipboardEvent) => {
    const range = nativeRange();
    if (!range || !event.clipboardData) return;
    const position = (node: Node, offset: number) => {
      const rows = Array.from(mirror.children);
      if (node === mirror) return offset < rows.length ? { row: offset, offset: 0 } : { row: rows.length - 1, offset: snapshotRows.at(-1)?.text.length ?? 0 };
      const rowIndex = rows.findIndex((row) => row.contains(node));
      if (rowIndex < 0) return null;
      const prefix = ownerDocument.createRange();
      prefix.selectNodeContents(rows[rowIndex]);
      prefix.setEnd(node, offset);
      return { row: rowIndex, offset: prefix.toString().length };
    };
    const start = position(range.startContainer, range.startOffset);
    const end = position(range.endContainer, range.endOffset);
    if (!start || !end) return;
    event.clipboardData.setData("text/plain", joinNativeTerminalSelection(snapshotRows, start, end));
    event.preventDefault();
    event.stopPropagation();
  };

  const renderSubscription = terminal.onRender(scheduleSync);
  const scrollSubscription = terminal.onScroll(scheduleSync);
  const resizeSubscription = terminal.onResize(scheduleSync);
  root.addEventListener("pointerdown", pointerDown, true);
  root.addEventListener("pointermove", pointerMove, true);
  root.addEventListener("pointerup", pointerEnd, true);
  root.addEventListener("pointercancel", pointerEnd, true);
  root.addEventListener("mousedown", mouseDown, true);
  root.addEventListener("contextmenu", contextMenu, true);
  root.addEventListener("paste", pasteEvent, true);
  ownerDocument.addEventListener("copy", copyEvent, true);
  textarea.addEventListener("beforeinput", pasteEvent, true);
  textarea.addEventListener("input", pasteEvent, true);
  ownerDocument.addEventListener("selectionchange", selectionChanged);
  scheduleSync();

  return {
    hasSelection,
    ownsTouch,
    isHoldingText,
    consumeClick() {
      const ignored = ignoreClick || hasSelection();
      ignoreClick = false;
      return ignored;
    },
    dispose() {
      disposed = true;
      view.clearTimeout(resumeTimer);
      if (renderFrame !== undefined) view.cancelAnimationFrame(renderFrame);
      renderSubscription.dispose();
      scrollSubscription.dispose();
      resizeSubscription.dispose();
      root.removeEventListener("pointerdown", pointerDown, true);
      root.removeEventListener("pointermove", pointerMove, true);
      root.removeEventListener("pointerup", pointerEnd, true);
      root.removeEventListener("pointercancel", pointerEnd, true);
      root.removeEventListener("mousedown", mouseDown, true);
      root.removeEventListener("contextmenu", contextMenu, true);
      root.removeEventListener("paste", pasteEvent, true);
      ownerDocument.removeEventListener("copy", copyEvent, true);
      textarea.removeEventListener("beforeinput", pasteEvent, true);
      textarea.removeEventListener("input", pasteEvent, true);
      ownerDocument.removeEventListener("selectionchange", selectionChanged);
      mirror.remove();
      root.classList.remove("terminal-native-touch");
    },
  };
}
