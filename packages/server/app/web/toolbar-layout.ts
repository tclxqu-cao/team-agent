export interface ToolbarLayoutInput {
  toolWidths: number[];
  availableWidth: number;
  fullAvailableWidth: number;
  avatarWidth: number;
  toggleWidth: number;
  gap: number;
  expanded: boolean;
}

/** Keep the fixed controls visible and send only the remaining tools to overflow. */
export function resolveToolbarLayout(input: ToolbarLayoutInput) {
  const active = input.toolWidths.flatMap((width, index) => width > 0 ? [index] : []);
  const width = (indices: number[]) => indices.reduce((total, index) => total + input.toolWidths[index], 0)
    + indices.length * input.gap;
  const fullFits = width(active) + input.avatarWidth <= input.fullAvailableWidth;
  if (fullFits) return { fullFits, inlineIndices: active, overflowIndices: [] as number[] };
  if (!input.expanded) return { fullFits, inlineIndices: [] as number[], overflowIndices: active };
  const available = input.availableWidth - input.avatarWidth - input.toggleWidth;
  if (width(active) <= available) return { fullFits, inlineIndices: active, overflowIndices: [] as number[] };
  const inlineIndices: number[] = [];
  for (const index of active) {
    if (width([...inlineIndices, index]) > available - input.toggleWidth) break;
    inlineIndices.push(index);
  }
  return { fullFits, inlineIndices, overflowIndices: active.slice(inlineIndices.length) };
}
