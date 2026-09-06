import { useEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import type { SessionQueryIndexEntry } from "../global";

const MAX_TICKS = 60;
const MIN_RAIL_HEIGHT = 32;
const MAX_RAIL_HEIGHT = 240;
const TICK_SPACING = 6;
const WEB_TICK_SPACING = 10;

export function queryIndexFromPointer(clientY: number, top: number, height: number, count: number): number {
  if (count <= 1 || height <= 0) return 0;
  const ratio = Math.max(0, Math.min(1, (clientY - top) / height));
  return Math.round(ratio * (count - 1));
}

export function queryTickIndices(count: number): number[] {
  const tickCount = Math.min(Math.max(0, count), MAX_TICKS);
  if (tickCount <= 1) return tickCount === 1 ? [0] : [];
  return Array.from({ length: tickCount }, (_, index) => (
    Math.round((index / (tickCount - 1)) * (count - 1))
  ));
}

export function queryRailHeight(count: number, tickSpacing = TICK_SPACING): number {
  return Math.min(
    MAX_RAIL_HEIGHT,
    Math.max(MIN_RAIL_HEIGHT, Math.min(Math.max(0, count), MAX_TICKS) * tickSpacing),
  );
}

export function queryKeyboardIndex(
  current: number,
  key: string,
  count: number,
): number | null {
  if (count <= 0) return null;
  const page = Math.max(5, Math.round(count / 10));
  if (key === "ArrowUp" || key === "ArrowLeft") return Math.max(0, current - 1);
  if (key === "ArrowDown" || key === "ArrowRight") return Math.min(count - 1, current + 1);
  if (key === "PageUp") return Math.max(0, current - page);
  if (key === "PageDown") return Math.min(count - 1, current + page);
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

interface QueryNavigationRailProps {
  entries: SessionQueryIndexEntry[];
  activeMessageId?: string | null;
  loadingMessageId?: string | null;
  onActivate(entry: SessionQueryIndexEntry): void;
}

export function QueryNavigationRail({
  entries,
  activeMessageId,
  loadingMessageId,
  onActivate,
}: QueryNavigationRailProps) {
  const matchedActiveIndex = entries.findIndex((entry) => entry.messageId === activeMessageId);
  const activeIndex = matchedActiveIndex >= 0 ? matchedActiveIndex : Math.max(0, entries.length - 1);
  const [selectedIndex, setSelectedIndex] = useState(activeIndex);
  const [open, setOpen] = useState(false);
  const draggingRef = useRef(false);
  const ticks = useMemo(() => queryTickIndices(entries.length), [entries.length]);

  useEffect(() => setSelectedIndex(activeIndex), [activeIndex]);

  if (entries.length < 2) return null;
  const safeIndex = Math.min(selectedIndex, entries.length - 1);
  const selected = entries[safeIndex];
  const isLoading = loadingMessageId === selected.messageId;

  const selectPointer = (clientY: number, element: HTMLDivElement) => {
    const rect = element.getBoundingClientRect();
    setSelectedIndex(queryIndexFromPointer(clientY, rect.top, rect.height, entries.length));
  };

  return (
    <div
      className={`query-navigation-rail${open ? " query-navigation-rail--open" : ""}`}
      style={{
        "--query-navigation-rail-height": `${queryRailHeight(entries.length)}px`,
        "--query-navigation-rail-web-height": `${queryRailHeight(entries.length, WEB_TICK_SPACING)}px`,
      } as React.CSSProperties}
      role="slider"
      tabIndex={0}
      aria-label="用户消息导航"
      aria-orientation="vertical"
      aria-valuemin={1}
      aria-valuemax={entries.length}
      aria-valuenow={selected.ordinal}
      aria-valuetext={`第 ${selected.ordinal} 条：${selected.preview}`}
      aria-busy={isLoading || undefined}
      onPointerEnter={(event) => {
        setOpen(true);
        selectPointer(event.clientY, event.currentTarget);
      }}
      onPointerMove={(event) => {
        if (event.pointerType === "touch" && !draggingRef.current) return;
        selectPointer(event.clientY, event.currentTarget);
      }}
      onPointerLeave={() => {
        if (!draggingRef.current) setOpen(false);
      }}
      onPointerDown={(event) => {
        draggingRef.current = true;
        setOpen(true);
        event.currentTarget.setPointerCapture(event.pointerId);
        selectPointer(event.clientY, event.currentTarget);
      }}
      onPointerUp={(event) => {
        selectPointer(event.clientY, event.currentTarget);
        const nextIndex = queryIndexFromPointer(
          event.clientY,
          event.currentTarget.getBoundingClientRect().top,
          event.currentTarget.getBoundingClientRect().height,
          entries.length,
        );
        draggingRef.current = false;
        event.currentTarget.releasePointerCapture(event.pointerId);
        onActivate(entries[nextIndex]);
        if (event.pointerType === "touch") setOpen(false);
      }}
      onPointerCancel={() => {
        draggingRef.current = false;
        setOpen(false);
      }}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          onActivate(selected);
          return;
        }
        const next = queryKeyboardIndex(safeIndex, event.key, entries.length);
        if (next === null) return;
        event.preventDefault();
        setSelectedIndex(next);
      }}
    >
      <div className="query-navigation-rail__track" aria-hidden="true">
        {ticks.map((entryIndex) => (
          <span
            key={entryIndex}
            className={`query-navigation-rail__tick${entryIndex === safeIndex ? " is-selected" : ""}${entries[entryIndex].messageId === activeMessageId ? " is-active" : ""}`}
          />
        ))}
        <span
          className="query-navigation-rail__marker"
          style={{ top: `${safeIndex / Math.max(1, entries.length - 1) * 100}%` }}
        />
      </div>
      {isLoading && (
        <span className="query-navigation-rail__loading" role="status" aria-label="正在定位消息">
          <LoaderCircle size={14} aria-hidden="true" />
        </span>
      )}
      {open && (
        <div className="query-navigation-rail__preview" role="status">
          <span>{selected.ordinal} / {entries.length}</span>
          <p>{selected.preview}</p>
        </div>
      )}
    </div>
  );
}
