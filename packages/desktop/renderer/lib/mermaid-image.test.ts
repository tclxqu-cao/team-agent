import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clampDiagramScale, exportMermaidPng, fitDiagramScale, getDiagramSize, getPngSize } from "./mermaid-image";

const render = vi.hoisted(() => vi.fn());
vi.mock("./mermaid-renderer", () => ({ renderMermaid: render }));

describe("Mermaid image geometry", () => {
  it("reads natural dimensions including negative origins and decimal bounds", () => {
    expect(getDiagramSize('<svg viewBox="-8 -12 399.5 654">')).toEqual({ width: 399.5, height: 654 });
    expect(getDiagramSize("<svg viewBox='0,0,1200,600'>")).toEqual({ width: 1200, height: 600 });
  });

  it.each(['<svg>', '<svg viewBox="0 0 0 12">', '<svg viewBox="0 0 NaN 12">', '<svg viewBox="0 0 12 Infinity">'])("handles invalid dimensions safely: %s", (svg) => {
    expect(getDiagramSize(svg)).toEqual({ width: 640, height: 480 });
  });

  it("fits mobile width and fits both axes in fullscreen without enlarging small charts", () => {
    expect(fitDiagramScale({ width: 1000, height: 2000 }, 340)).toBe(0.34);
    expect(fitDiagramScale({ width: 1000, height: 2000 }, 340, 500)).toBe(0.25);
    expect(fitDiagramScale({ width: 100, height: 100 }, 340, 500)).toBe(1);
    expect(fitDiagramScale({ width: 2400, height: 1000 }, 240)).toBe(0.1);
  });

  it("clamps zoom while preserving very small fit scales for wide diagrams", () => {
    expect(clampDiagramScale(8, 0.5)).toBe(4);
    expect(clampDiagramScale(0, 0.5)).toBe(0.1);
    expect(clampDiagramScale(0, 0.03)).toBe(0.03);
    expect(clampDiagramScale(1.25, 0.5)).toBe(1.25);
  });

  it("exports the full chart at 2x resolution within a mobile-safe canvas limit", () => {
    expect(getPngSize({ width: 400, height: 650 })).toEqual({ width: 800, height: 1300 });
    expect(getPngSize({ width: 10000, height: 20000 })).toEqual({ width: 2048, height: 4096 });
    expect(getPngSize({ width: 1, height: 20000 })).toEqual({ width: 1, height: 4096 });
  });
});

describe("Mermaid PNG export", () => {
  const root = { setAttribute: vi.fn(), style: {} };
  const querySelector = vi.fn();
  const querySelectorAll = vi.fn();
  const revoke = vi.fn();
  const drawImage = vi.fn();
  const canvas = { width: 0, height: 0, getContext: vi.fn(), toBlob: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    querySelector.mockReturnValue(null);
    querySelectorAll.mockReturnValue([]);
    render.mockResolvedValue('<svg viewBox="0 0 400 650"></svg>');
    vi.stubGlobal("DOMParser", class {
      parseFromString() { return { documentElement: root, querySelector, querySelectorAll }; }
    });
    vi.stubGlobal("XMLSerializer", class { serializeToString() { return "<svg />"; } });
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:svg"), revokeObjectURL: revoke });
    vi.stubGlobal("Image", class {
      onload?: () => void;
      set src(_value: string) { this.onload?.(); }
    });
    canvas.getContext.mockReturnValue({ fillStyle: "", fillRect: vi.fn(), drawImage });
    canvas.toBlob.mockImplementation((callback) => callback(new Blob(["png"], { type: "image/png" })));
    vi.stubGlobal("window", { document: { createElement: () => canvas } });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("rasterizes the full SVG with an opaque background and releases its URL", async () => {
    const blob = await exportMermaidPng("flowchart TB\nA-->B");
    expect(blob.type).toBe("image/png");
    expect(render).toHaveBeenCalledWith("flowchart TB\nA-->B", true);
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 800, 1300);
    expect(canvas.width).toBe(800);
    expect(canvas.height).toBe(1300);
    expect(revoke).toHaveBeenCalledWith("blob:svg");
  });

  it("releases its SVG URL when canvas export fails", async () => {
    canvas.toBlob.mockImplementation(() => { throw new Error("tainted canvas"); });
    await expect(exportMermaidPng("graph TB")).rejects.toThrow("tainted canvas");
    expect(revoke).toHaveBeenCalledWith("blob:svg");
  });

  it("rejects unsupported HTML instead of returning a blank picture", async () => {
    querySelector.mockReturnValue({});
    await expect(exportMermaidPng("graph TB")).rejects.toThrow("暂不支持导出");
    expect(drawImage).not.toHaveBeenCalled();
  });

  it("rejects externally referenced images before rasterization", async () => {
    querySelectorAll.mockReturnValue([{ getAttribute: () => "https://example.com/image.png" }]);
    await expect(exportMermaidPng("graph TB")).rejects.toThrow("外部图片");
    expect(drawImage).not.toHaveBeenCalled();
  });
});
