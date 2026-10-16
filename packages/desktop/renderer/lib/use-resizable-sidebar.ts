import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

const MIN_WIDTH = 220;
const MAX_WIDTH = 480;
const COLLAPSE_WIDTH = 180;

/** Pointer capture keeps resizing reliable even when the sidebar slides away. */
export function useResizableSidebar() {
  const [width, setWidth] = useState(300);
  const [collapsed, setCollapsed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number; target: HTMLDivElement } | null>(null);

  const onPointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width, target: event.currentTarget };
    setDragging(true);
  }, [width]);

  const onPointerMove = useCallback((event: { pointerId: number; clientX: number }) => {
    const current = drag.current;
    if (!current || event.pointerId !== current.pointerId) return;
    const nextWidth = current.startWidth + event.clientX - current.startX;
    const nextCollapsed = nextWidth <= COLLAPSE_WIDTH;
    setCollapsed(nextCollapsed);
    // A collapsed drag restores the width from before the gesture.
    setWidth(nextCollapsed ? current.startWidth : Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, nextWidth)));
  }, []);

  const clearDrag = useCallback(() => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    setDragging(false);
    if (current.target.hasPointerCapture(current.pointerId)) {
      current.target.releasePointerCapture(current.pointerId);
    }
  }, []);

  const endDrag = useCallback((event: { pointerId: number }) => {
    if (event.pointerId === drag.current?.pointerId) clearDrag();
  }, [clearDrag]);

  const onPointerUp = useCallback((event: { pointerId: number; clientX: number }) => {
    // Fast drags can release beyond the last delivered pointermove.
    onPointerMove(event);
    endDrag(event);
  }, [onPointerMove, endDrag]);

  useEffect(() => {
    if (!dragging) return;
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", endDrag);
    window.addEventListener("blur", clearDrag);
    return () => {
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", endDrag);
      window.removeEventListener("blur", clearDrag);
    };
  }, [dragging, onPointerUp, endDrag, clearDrag]);

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      setCollapsed(true);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      setWidth(current => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, current + (event.key === "ArrowLeft" ? -20 : 20))));
    }
  }, []);

  const toggle = useCallback(() => setCollapsed(current => !current), []);

  return {
    width, collapsed, dragging, toggle,
    resizeProps: {
      onPointerDown, onPointerMove, onPointerUp,
      onPointerCancel: endDrag, onLostPointerCapture: endDrag, onKeyDown,
    },
  };
}
