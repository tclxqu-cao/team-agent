"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

interface Props {
  id: string;
  label: string;
  className: string;
  disabled: boolean;
  children: ReactNode;
  onMove(source: string, target: string): void;
}

export default function SortableToolbarAction({ id, label, className, disabled, children, onMove }: Props) {
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const gesture = useRef<{ pointer: number; x: number; y: number; active: boolean; target: string; node: HTMLDivElement } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const suppressClickUntil = useRef(0);
  const clear = () => {
    clearTimeout(timer.current);
    document.querySelectorAll(".toolbar-sort-target").forEach(node => node.classList.remove("toolbar-sort-target"));
    gesture.current = null;
    setDrag(null);
  };
  useEffect(() => () => { clearTimeout(timer.current); }, []);

  return <div className={`${className} sortable-toolbar-action${drag ? " is-dragging" : ""}`}
    data-toolbar-sort-id={id} title={`${label} · 长按拖动排序`} aria-description="长按拖动排序，也可按 Alt 加方向键调整顺序"
    style={drag ? { transform: `translate(${drag.x}px, ${drag.y}px)` } : undefined}
    onContextMenu={event => event.preventDefault()}
    onKeyDown={event => {
      if (disabled || !event.altKey || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
      const nodes = Array.from(event.currentTarget.parentElement!.querySelectorAll<HTMLElement>("[data-toolbar-sort-id]"));
      const step = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" ? -3 : 3;
      const target = nodes[nodes.indexOf(event.currentTarget) + step]?.dataset.toolbarSortId;
      if (target) { event.preventDefault(); onMove(id, target); }
    }}
    onPointerDownCapture={event => {
      if (disabled || event.button !== 0 || !event.isPrimary) return;
      const node = event.currentTarget;
      const state = { pointer: event.pointerId, x: event.clientX, y: event.clientY, active: false, target: id, node };
      gesture.current = state;
      if (event.pointerType !== "mouse") timer.current = setTimeout(() => {
        if (gesture.current !== state) return;
        state.active = true;
        node.setPointerCapture(state.pointer);
        setDrag({ x: 0, y: 0 });
      }, 260);
    }}
    onPointerMove={event => {
      const state = gesture.current;
      if (!state || state.pointer !== event.pointerId) return;
      const x = event.clientX - state.x, y = event.clientY - state.y;
      if (!state.active && event.pointerType === "mouse" && Math.hypot(x, y) >= 6) {
        state.active = true;
        state.node.setPointerCapture(state.pointer);
      }
      if (!state.active) {
        if (Math.hypot(x, y) >= 10) clear();
        return;
      }
      event.preventDefault();
      setDrag({ x, y });
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-toolbar-sort-id]");
      document.querySelectorAll(".toolbar-sort-target").forEach(node => node.classList.remove("toolbar-sort-target"));
      state.target = target?.dataset.toolbarSortId ?? id;
      if (state.target !== id) target?.classList.add("toolbar-sort-target");
    }}
    onPointerUp={event => {
      const state = gesture.current;
      if (!state || state.pointer !== event.pointerId) return;
      if (state.active) {
        suppressClickUntil.current = Date.now() + 500;
        if (state.node.hasPointerCapture(state.pointer)) state.node.releasePointerCapture(state.pointer);
        if (state.target !== id) onMove(id, state.target);
      }
      clear();
    }}
    onPointerCancel={clear}
    onClickCapture={event => {
      if (Date.now() < suppressClickUntil.current) { event.preventDefault(); event.stopPropagation(); }
    }}
  >{children}</div>;
}
