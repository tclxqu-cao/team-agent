import { describe, expect, it } from "vitest";
import { computePaneRects, normalizeRatios } from "./ai-hub-layout";

const CONTAINER = { x: 200, y: 52, width: 800, height: 600 };

describe("normalizeRatios", () => {
  it("单列返回单段满占比", () => {
    expect(normalizeRatios([], 1)).toEqual([1]);
    expect(normalizeRatios([], 0)).toEqual([]);
  });

  it("缺省比例视为等分", () => {
    expect(normalizeRatios([], 2)).toEqual([0.5, 0.5]);
    expect(normalizeRatios([1], 3)).toEqual([1 / 3, 1 / 3, 1 / 3]);
  });

  it("按比例归一化", () => {
    const ratios = normalizeRatios([1, 3], 2);
    expect(ratios[0]).toBeCloseTo(0.25);
    expect(ratios[1]).toBeCloseTo(0.75);
  });

  it("极小比例 clamp 到最小值后重新归一", () => {
    const ratios = normalizeRatios([0.001, 10], 2, 0.12);
    expect(ratios.every((value) => value > 0)).toBe(true);
    expect(ratios.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1);
    expect(ratios[0]).toBeGreaterThanOrEqual(0.12 / (0.12 + 1) * 0.999);
  });

  it("非有限输入回退为等分", () => {
    expect(normalizeRatios([Number.NaN, Number.NEGATIVE_INFINITY], 2)).toEqual([0.5, 0.5]);
  });
});

describe("computePaneRects", () => {
  it("单列占满容器", () => {
    const rects = computePaneRects(CONTAINER, 1, []);
    expect(rects).toEqual([{ x: 200, y: 52, width: 800, height: 600 }]);
  });

  it("双列等分且 gap 分隔", () => {
    const rects = computePaneRects(CONTAINER, 2, [], 8);
    expect(rects).toHaveLength(2);
    expect(rects[0]).toEqual({ x: 200, y: 52, width: 396, height: 600 });
    expect(rects[1].x).toBe(200 + 396 + 8);
    expect(rects[1].x + rects[1].width).toBe(200 + 800);
    expect(rects[1].height).toBe(600);
  });

  it("三列不重叠不越界", () => {
    const rects = computePaneRects(CONTAINER, 3, [1, 1, 1], 8);
    expect(rects).toHaveLength(3);
    for (let index = 0; index < rects.length - 1; index += 1) {
      expect(rects[index].x + rects[index].width + 8).toBe(rects[index + 1].x);
    }
    expect(rects[2].x + rects[2].width).toBe(1000);
    expect(rects.every((rect) => rect.y === 52 && rect.height === 600)).toBe(true);
  });

  it("四列按比例分配宽度", () => {
    const rects = computePaneRects(CONTAINER, 4, [1, 1, 1, 1], 8);
    const usable = 800 - 8 * 3;
    expect(rects[0].width).toBe(Math.floor(usable / 4));
    expect(rects[3].x + rects[3].width).toBe(1000);
    for (let index = 0; index < rects.length - 1; index += 1) {
      expect(rects[index].x + rects[index].width + 8).toBe(rects[index + 1].x);
    }
  });

  it("整数取整无缝隙", () => {
    const rects = computePaneRects(CONTAINER, 3, [1, 2, 2], 8);
    for (let index = 0; index < rects.length - 1; index += 1) {
      expect(rects[index].x + rects[index].width + 8).toBe(rects[index + 1].x);
    }
    expect(Number.isInteger(rects[0].width)).toBe(true);
  });

  it("容器宽高为 0 返回空", () => {
    expect(computePaneRects({ x: 0, y: 0, width: 0, height: 600 }, 2, [])).toEqual([]);
    expect(computePaneRects({ x: 0, y: 0, width: 800, height: 0 }, 2, [])).toEqual([]);
  });

  it("列数上限 6", () => {
    const rects = computePaneRects(CONTAINER, 12, [], 8);
    expect(rects).toHaveLength(6);
  });
});
