import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface TaskPanelPosition { x: number; y: number }
export interface TaskPanelPreferences { visible: boolean; position: TaskPanelPosition | null }
export interface TaskPanelBounds { width: number; height: number; panelWidth: number; panelHeight: number }

const INSET = 8;
const DEFAULT: TaskPanelPreferences = { visible: false, position: null };
const clamp = (value: number, maximum = 1) => Math.max(0, Math.min(maximum, value));

function travel(bounds: TaskPanelBounds) {
  return { x: Math.max(0, bounds.width - bounds.panelWidth - INSET * 2),
    y: Math.max(0, bounds.height - bounds.panelHeight - INSET * 2) };
}

export function taskPanelPixels(position: TaskPanelPosition, bounds: TaskPanelBounds): TaskPanelPosition {
  const extent = travel(bounds);
  return { x: INSET + clamp(position.x) * extent.x, y: INSET + clamp(position.y) * extent.y };
}

export function taskPanelPosition(pixels: TaskPanelPosition, bounds: TaskPanelBounds): TaskPanelPosition {
  const extent = travel(bounds);
  return { x: extent.x ? clamp((pixels.x - INSET) / extent.x) : 0,
    y: extent.y ? clamp((pixels.y - INSET) / extent.y) : 0 };
}

export function readTaskPanelPreferences(value: unknown): TaskPanelPreferences {
  if (!value || typeof value !== "object") return { ...DEFAULT };
  const input = value as Partial<TaskPanelPreferences>;
  const position = input.position;
  return { visible: typeof input.visible === "boolean" ? input.visible : false,
    position: position && Number.isFinite(position.x) && Number.isFinite(position.y)
      ? { x: clamp(position.x), y: clamp(position.y) } : null };
}

export function migrateTaskPanelPreferences(value: unknown): TaskPanelPreferences {
  // v1 also persisted implicit visibility when dragging, so only retain placement.
  return { ...readTaskPanelPreferences(value), visible: false };
}

export function useTaskPanelPreferences(scope: string, revealSignal?: string) {
  const key = `agentroam:session-task-panel:v2:${scope}`;
  const saved = useMemo(() => {
    try {
      const value = localStorage.getItem(key);
      return value !== null ? readTaskPanelPreferences(JSON.parse(value))
        : migrateTaskPanelPreferences(JSON.parse(localStorage.getItem(`agentroam:session-task-panel:v1:${scope}`) || "null"));
    }
    catch { return { ...DEFAULT }; }
  }, [key, scope]);
  const [overrides, setOverrides] = useState<Record<string, TaskPanelPreferences>>({});
  const revealed = useRef(new Set<string>());
  const preferences = overrides[key] ?? saved;
  const update = useCallback((patch: Partial<TaskPanelPreferences>) => {
    const next = readTaskPanelPreferences({ ...preferences, ...patch });
    setOverrides(current => ({ ...current, [key]: next }));
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* Still usable when device storage is unavailable. */ }
  }, [key, preferences]);
  useEffect(() => {
    if (!revealSignal || revealed.current.has(revealSignal)) return;
    revealed.current.add(revealSignal);
    update({ visible: true });
  }, [key, revealSignal, update]);
  return { preferences, update };
}
