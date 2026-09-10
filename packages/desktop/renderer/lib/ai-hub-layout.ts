export interface HubRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const DEFAULT_GAP = 8;
const MIN_RATIO = 0.12;

// 把 n 列的占比归一到 (0,1) 且每份 >= min；缺失/非法项视为等分。
// count<=0 返回 []；单列返回 [1]。
export function normalizeRatios(ratios: number[], count: number, min = MIN_RATIO): number[] {
  if (count <= 0) return [];
  const cleaned = Array.from({ length: count }, (_, index) => {
    const value = Number(ratios[index]);
    return Number.isFinite(value) && value > 0 ? value : 1;
  });
  const total = cleaned.reduce((sum, value) => sum + value, 0);
  const scaled = cleaned.map((value) => value / total);
  // 逐份 clamp 到 min 后重新归一，避免某一份被挤成 0
  const clamped = scaled.map((value) => Math.max(value, min));
  const clampedTotal = clamped.reduce((sum, value) => sum + value, 0);
  return clamped.map((value) => value / clampedTotal);
}

// 对比模式单行 n 列：按比例切容器宽，gap 分隔，整像素取整且不留缝、不重叠。
// count <= 1 时返回整块容器。
export function computePaneRects(
  container: HubRect,
  count: number,
  ratios: number[],
  gap = DEFAULT_GAP,
): HubRect[] {
  if (count <= 1 || container.width <= 0 || container.height <= 0) {
    if (container.width <= 0 || container.height <= 0) return [];
    return [{ x: Math.round(container.x), y: Math.round(container.y), width: Math.round(container.width), height: Math.round(container.height) }];
  }
  const columns = Math.min(count, 6);
  const totalGap = gap * (columns - 1);
  const usableWidth = container.width - totalGap;
  if (usableWidth <= 0) return [];
  const normalized = normalizeRatios(ratios, columns);
  const rects: HubRect[] = [];
  let cursor = container.x;
  for (let index = 0; index < columns; index += 1) {
    const isLast = index === columns - 1;
    const width = isLast
      ? container.x + container.width - cursor // 最后列吃齐右边界，消除累计取整误差
      : Math.floor(usableWidth * normalized[index]);
    rects.push({
      x: Math.round(cursor),
      y: Math.round(container.y),
      width: Math.round(width),
      height: Math.round(container.height),
    });
    cursor += width + gap;
  }
  return rects;
}
