export type TaskSplitNode =
  | { kind: "pane"; paneId: string }
  | { kind: "split"; id: string; axis: "columns" | "rows"; ratio: number; first: TaskSplitNode; second: TaskSplitNode };

export function equalTaskLayout(paneIds: readonly string[], depth = 0): TaskSplitNode | null {
  if (!paneIds.length) return null;
  if (paneIds.length === 1) return { kind: "pane", paneId: paneIds[0] };
  const middle = Math.ceil(paneIds.length / 2);
  return {
    kind: "split", id: `split:${paneIds.join("|")}`, axis: depth % 2 === 0 ? "columns" : "rows",
    ratio: middle / paneIds.length,
    first: equalTaskLayout(paneIds.slice(0, middle), depth + 1)!,
    second: equalTaskLayout(paneIds.slice(middle), depth + 1)!,
  };
}

export function taskPaneIds(node: TaskSplitNode | null): string[] {
  if (!node) return [];
  return node.kind === "pane" ? [node.paneId] : [...taskPaneIds(node.first), ...taskPaneIds(node.second)];
}

export function fourColumnTaskLayout(paneIds: readonly string[]): TaskSplitNode | null {
  const combine = (nodes: TaskSplitNode[], axis: "columns" | "rows"): TaskSplitNode | null => {
    if (!nodes.length) return null;
    if (nodes.length === 1) return nodes[0];
    const middle = Math.ceil(nodes.length / 2);
    return { kind: "split", id: `split:${axis}:${nodes.flatMap(taskPaneIds).join("|")}`, axis,
      ratio: middle / nodes.length, first: combine(nodes.slice(0, middle), axis)!, second: combine(nodes.slice(middle), axis)! };
  };
  const groups = Array.from({ length: Math.min(4, paneIds.length) }, () => [] as TaskSplitNode[]);
  paneIds.forEach((paneId, index) => groups[index % groups.length].push({ kind: "pane", paneId }));
  return combine(groups.map(group => combine(group, "rows")!), "columns");
}

/** Append a full-height column while preserving the existing branches and proportions. */
export function appendTaskColumn(node: TaskSplitNode, paneId: string): TaskSplitNode {
  const columns = (item: TaskSplitNode): number => item.kind === "pane" ? 1
    : item.axis === "columns" ? columns(item.first) + columns(item.second) : Math.max(columns(item.first), columns(item.second));
  const count = columns(node);
  return { kind: "split", id: `split:column:${paneId}`, axis: "columns", ratio: Math.min(.9, count / (count + 1)),
    first: node, second: { kind: "pane", paneId } };
}

/** Split just one slot; every other branch and user-adjusted ratio stays intact. */
export function insertTaskPane(node: TaskSplitNode, paneId: string, afterId: string, axis: "columns" | "rows"): TaskSplitNode {
  const ids = taskPaneIds(node);
  if (ids.includes(paneId)) return node;
  const target = ids.includes(afterId) ? afterId : ids[ids.length - 1];
  const insert = (item: TaskSplitNode): TaskSplitNode => {
    if (item.kind === "pane") return item.paneId === target
      ? { kind: "split", id: `split:add:${target}|${paneId}`, axis, ratio: .5, first: item, second: { kind: "pane", paneId } } : item;
    const first = insert(item.first), second = insert(item.second);
    return first === item.first && second === item.second ? item : { ...item, first, second };
  };
  return insert(node);
}

export function swapTaskPanes(node: TaskSplitNode, source: string, target: string): TaskSplitNode {
  const ids = taskPaneIds(node);
  if (source === target || !ids.includes(source) || !ids.includes(target)) return node;
  const swap = (item: TaskSplitNode): TaskSplitNode => {
    if (item.kind === "pane") return item.paneId === source ? { ...item, paneId: target }
      : item.paneId === target ? { ...item, paneId: source } : item;
    const first = swap(item.first), second = swap(item.second);
    return first === item.first && second === item.second ? item : { ...item, first, second };
  };
  return swap(node);
}

export interface TaskPaneRect { x: number; y: number; width: number; height: number }

/** Flat siblings keep each conversation mounted while its rectangle moves. */
export function taskSplitGeometry(node: TaskSplitNode, width: number, height: number) {
  const panes: Array<{ paneId: string; rect: TaskPaneRect }> = [];
  const separators: Array<{ id: string; axis: "columns" | "rows"; ratio: number; extent: number; rect: TaskPaneRect }> = [];
  const visit = (item: TaskSplitNode, rect: TaskPaneRect) => {
    if (item.kind === "pane") { panes.push({ paneId: item.paneId, rect }); return; }
    const columns = item.axis === "columns";
    const extent = Math.max(0, (columns ? rect.width : rect.height) - 1);
    const first = extent * item.ratio;
    const line = Math.min(1, columns ? rect.width : rect.height);
    separators.push({ id: item.id, axis: item.axis, ratio: item.ratio, extent,
      rect: columns ? { ...rect, x: rect.x + first, width: line } : { ...rect, y: rect.y + first, height: line } });
    visit(item.first, columns ? { ...rect, width: first } : { ...rect, height: first });
    visit(item.second, columns ? { ...rect, x: rect.x + first + line, width: extent - first }
      : { ...rect, y: rect.y + first + line, height: extent - first });
  };
  visit(node, { x: 0, y: 0, width: Math.max(0, width), height: Math.max(0, height) });
  return { panes, separators };
}

export function resizeTaskSplit(node: TaskSplitNode, id: string, ratio: number): TaskSplitNode {
  if (node.kind === "pane" || !Number.isFinite(ratio)) return node;
  if (node.id === id) return { ...node, ratio: Math.max(0.1, Math.min(0.9, ratio)) };
  const first = resizeTaskSplit(node.first, id, ratio);
  const second = resizeTaskSplit(node.second, id, ratio);
  return first === node.first && second === node.second ? node : { ...node, first, second };
}

export function removeTaskPane(node: TaskSplitNode, paneId: string): TaskSplitNode | null {
  if (node.kind === "pane") return node.paneId === paneId ? null : node;
  const first = removeTaskPane(node.first, paneId);
  const second = removeTaskPane(node.second, paneId);
  if (!first) return second;
  if (!second) return first;
  return first === node.first && second === node.second ? node : { ...node, first, second };
}

export function taskSplitPointerRatio(initial: number, delta: number, extent: number): number {
  if (!Number.isFinite(extent) || extent <= 0 || !Number.isFinite(delta)) return initial;
  const minimum = Math.min(0.45, Math.max(0.1, 100 / extent));
  return Math.max(minimum, Math.min(1 - minimum, initial + delta / extent));
}

/** Never trust a saved tree to render duplicate panes, invalid ratios or unbounded recursion. */
export function readTaskLayout(value: unknown, expectedPaneIds: readonly string[]): TaskSplitNode | null {
  const seen = new Set<string>();
  const branches = new Set<string>();
  const expected = new Set(expectedPaneIds);
  if (!expected.size || expected.size !== expectedPaneIds.length || expected.size > 128) return null;
  const read = (input: unknown, depth: number): TaskSplitNode | null => {
    if (!input || typeof input !== "object" || depth > 32) return null;
    const item = input as Record<string, unknown>;
    if (item.kind === "pane") {
      if (typeof item.paneId !== "string" || !expected.has(item.paneId) || seen.has(item.paneId)) return null;
      seen.add(item.paneId);
      return { kind: "pane", paneId: item.paneId };
    }
    if (item.kind !== "split" || typeof item.id !== "string" || branches.has(item.id)
      || (item.axis !== "columns" && item.axis !== "rows")
      || typeof item.ratio !== "number" || !Number.isFinite(item.ratio) || item.ratio < 0.1 || item.ratio > 0.9) return null;
    branches.add(item.id);
    const first = read(item.first, depth + 1), second = read(item.second, depth + 1);
    return first && second ? { kind: "split", id: item.id, axis: item.axis, ratio: item.ratio, first, second } : null;
  };
  const result = read(value, 0);
  return result && seen.size === expected.size ? result : null;
}

/** A pane may finish an explicitly managed prior run, but must not consume another pane's queue. */
export function ownsTaskPaneEvent(sessionId: string | undefined, viewedId: string | null, managed: ReadonlySet<string>): boolean {
  return !sessionId || sessionId === viewedId || managed.has(sessionId);
}
