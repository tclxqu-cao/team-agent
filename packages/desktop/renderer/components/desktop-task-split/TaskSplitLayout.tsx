import { useLayoutEffect, useRef, useState, type ReactNode, type PointerEvent as ReactPointerEvent } from "react";
import { taskSplitGeometry, taskSplitPointerRatio, type TaskSplitNode } from "../../lib/desktop-task-layout";

interface Props {
  node: TaskSplitNode;
  renderPane(id: string): ReactNode;
  onResize(id: string, ratio: number): void;
  onSwap?: (source: string, target: string) => void;
  maximizedPaneId?: string | null;
}

export default function TaskSplitLayout({ node, renderPane, onResize, onSwap, maximizedPaneId }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const dividerDrag = useRef<{ id: string; coordinate: number; ratio: number; extent: number; columns: boolean } | null>(null);
  const paneDrag = useRef<{ source: string; target: string | null; pointerId: number; x: number; y: number; moved: boolean; element: HTMLDivElement } | null>(null);
  const [moving, setMoving] = useState<{ source: string; target: string | null } | null>(null);
  const geometry = taskSplitGeometry(node, size.width, size.height);

  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const measure = () => setSize(current => current.width === element.clientWidth && current.height === element.clientHeight
      ? current : { width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener("resize", measure);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); };
  }, []);

  const finishPaneDrag = (event: ReactPointerEvent<HTMLDivElement>, commit: boolean) => {
    const current = paneDrag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    paneDrag.current = null; setMoving(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (commit && current.moved && current.target) onSwap?.(current.source, current.target);
  };

  return <div ref={root} className={`task-split-layout${moving ? " is-reordering" : ""}`}
    onKeyDown={event => {
      if (event.key !== "Escape" || !paneDrag.current) return;
      const current = paneDrag.current;
      paneDrag.current = null; setMoving(null); event.stopPropagation();
      if (current.element.hasPointerCapture(current.pointerId)) current.element.releasePointerCapture(current.pointerId);
    }}>
    {geometry.panes.map(({ paneId, rect }) => <div key={paneId} data-task-slot={paneId}
      className={`task-split-pane${moving?.source === paneId ? " is-moving" : ""}${moving?.target === paneId ? " is-drop-target" : ""}`}
      style={maximizedPaneId ? { left: 0, top: 0, width: "100%", height: "100%", display: maximizedPaneId === paneId ? "flex" : "none" }
        : { left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
      onPointerDownCapture={event => {
        const target = event.target as Element;
        if (event.button !== 0 || !onSwap || maximizedPaneId || geometry.panes.length < 2
          || !target.closest(".chat-top-bar") || target.closest("button, input, textarea, select, a, [role='button'], [contenteditable='true']")) return;
        event.preventDefault();
        paneDrag.current = { source: paneId, target: null, pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false, element: event.currentTarget };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => {
        const current = paneDrag.current;
        const frame = root.current?.getBoundingClientRect();
        if (!current || current.pointerId !== event.pointerId || !frame) return;
        if (!current.moved && Math.hypot(event.clientX - current.x, event.clientY - current.y) < 6) return;
        current.moved = true;
        const x = event.clientX - frame.left, y = event.clientY - frame.top;
        current.target = geometry.panes.find(item => item.paneId !== current.source
          && x >= item.rect.x && x < item.rect.x + item.rect.width && y >= item.rect.y && y < item.rect.y + item.rect.height)?.paneId ?? null;
        setMoving(previous => previous?.source === current.source && previous.target === current.target ? previous : { source: current.source, target: current.target });
      }}
      onPointerUp={event => finishPaneDrag(event, true)} onPointerCancel={event => finishPaneDrag(event, false)}
      onLostPointerCapture={event => finishPaneDrag(event, false)}>
      {renderPane(paneId)}
      {moving?.target === paneId && <span className="task-pane-swap-hint" role="status">松开交换位置</span>}
    </div>)}
    {geometry.separators.map(separator => <div key={separator.id} className={`task-split-separator task-split-separator--${separator.axis}`}
      style={{ left: separator.rect.x, top: separator.rect.y, width: separator.rect.width, height: separator.rect.height, display: maximizedPaneId ? "none" : undefined }}
      role="separator" tabIndex={0} aria-label={separator.axis === "columns" ? "调整左右任务宽度" : "调整上下任务高度"}
      aria-orientation={separator.axis === "columns" ? "vertical" : "horizontal"} aria-valuemin={10} aria-valuemax={90} aria-valuenow={Math.round(separator.ratio * 100)}
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault();
        const columns = separator.axis === "columns";
        dividerDrag.current = { id: separator.id, coordinate: columns ? event.clientX : event.clientY, ratio: separator.ratio, extent: separator.extent, columns };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => {
        const current = dividerDrag.current;
        if (current) onResize(current.id, taskSplitPointerRatio(current.ratio, (current.columns ? event.clientX : event.clientY) - current.coordinate, current.extent));
      }}
      onPointerUp={event => { dividerDrag.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
      onPointerCancel={() => { dividerDrag.current = null; }} onLostPointerCapture={() => { dividerDrag.current = null; }}
      onDoubleClick={() => onResize(separator.id, 0.5)}
      onKeyDown={event => {
        const direction = separator.axis === "columns" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
        if (event.key === direction[0] || event.key === direction[1]) {
          event.preventDefault(); onResize(separator.id, separator.ratio + (event.key === direction[0] ? -0.05 : 0.05));
        } else if (event.key === "Home" || event.key === "End") {
          event.preventDefault(); onResize(separator.id, event.key === "Home" ? 0.1 : 0.9);
        }
      }} />)}
  </div>;
}
